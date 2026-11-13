/**
 * SWEEP2-R1 — one Idempotency-Key, one write, for every write route on the main API.
 *
 * The consoles' channel re-sends a request when the encrypted envelope does not come back (a dropped
 * fetch, a cold-start 502), up to three times. Nothing on the server recognised the second copy, so
 * a write that had landed before the reply was lost ran again. The console now sends one key per
 * intent (web/shell.js, web-platform/platform.js `raOnce`) and the /rpc tunnel forwards it as the
 * `idempotency-key` header; this interceptor, registered once in AppModule, honours it:
 *
 *   - first time a (user, key) is seen: a row is claimed `in_progress`, the handler runs, its result
 *     is stored and the row marked `completed`. If the handler throws, the claim is released, so a
 *     refused or failed write can be tried again with the same key.
 *   - the same key and the same request again: the stored result is returned and the handler does
 *     not run -- no second write, no second audit row.
 *   - the same key while the first is still running: 409, "still being processed".
 *   - the same key for a DIFFERENT request (method, path or body): 422 -- a key names one intent.
 *
 * A route marked @NoStoredReply() (IMPORT-RP: its answer carries a recipe's lines) keeps the claim while
 * it runs, so two copies cannot run at once, and then forgets it: nothing of its answer is stored, and a
 * later re-send runs again.
 *
 * No key, a GET, or no signed-in user: the request passes through unchanged, exactly as before.
 * Scope is the user (RawProd is single-tenant, like every platform table), so one person's key can
 * never answer another person's request.
 */
import { createHash } from 'node:crypto';
import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { DomainError, META_NO_STORED_REPLY, PG_CLIENT, type RequestWithUser } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { catchError, concatMap, from, of, throwError, type Observable } from 'rxjs';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY = /^[A-Za-z0-9._:-]{8,100}$/;

export type Claim =
  | { kind: 'run' }
  | { kind: 'replay'; response: unknown }
  | { kind: 'busy' }
  | { kind: 'mismatch' };

export function requestHash(method: string, url: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${url} ${JSON.stringify(body ?? null)}`).digest('hex');
}

/** The store, on its own so it can be tested against a real database without Nest. */
export class IdempotencyStore {
  /** `table` is fixed by the two interceptors below, never caller input. */
  constructor(private readonly sql: Sql, private readonly table = 'platform.idempotency_key') {}
  private get t() { return this.sql(this.table); } // postgres.js quotes a dotted name as schema.table

  async claim(userId: string, key: string, hash: string): Promise<Claim> {
    const inserted = await this.sql`
      insert into ${this.t} (user_id, idempotency_key, request_hash)
      values (${userId}, ${key}, ${hash})
      on conflict (user_id, idempotency_key) do nothing
      returning idempotency_key`;
    if (inserted.length) return { kind: 'run' };
    const rows = await this.sql<{ request_hash: string; state: string; response: unknown }[]>`
      select request_hash, state, response from ${this.t}
       where user_id = ${userId} and idempotency_key = ${key}`;
    const row = rows[0];
    if (!row) return this.claim(userId, key, hash); // released between the two statements
    if (row.request_hash !== hash) return { kind: 'mismatch' };
    if (row.state !== 'completed') return { kind: 'busy' };
    return { kind: 'replay', response: row.response };
  }

  async complete(userId: string, key: string, response: unknown): Promise<void> {
    await this.sql`
      update ${this.t}
         set state = 'completed', response = ${JSON.stringify(response ?? null)}::text::jsonb /* as write-audit does: sql.json here threw ERR_INVALID_ARG_TYPE and every keyed POST answered 500 */, completed_dt = now()
       where user_id = ${userId} and idempotency_key = ${key}`;
  }

  async release(userId: string, key: string): Promise<void> {
    await this.sql`delete from ${this.t}
                    where user_id = ${userId} and idempotency_key = ${key} and state = 'in_progress'`;
  }
}

export class IdempotencyInterceptorBase implements NestInterceptor {
  constructor(private readonly store: IdempotencyStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<RequestWithUser & { method: string; url: string; body?: unknown; headers: Record<string, unknown> }>();
    if (!MUTATING.has(String(req.method).toUpperCase())) return next.handle();
    const raw = req.headers?.['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (key === undefined || key === null || key === '') return next.handle();
    if (typeof key !== 'string' || !KEY.test(key)) {
      throw new DomainError('VALIDATION_FAILED', 'Idempotency-Key must be 8 to 100 letters, digits or . _ : -', 422);
    }
    const userId = req.user?.userId;
    if (!userId) return next.handle();
    const hash = requestHash(String(req.method).toUpperCase(), String(req.url), req.body);
    return from(this.store.claim(userId, key, hash)).pipe(
      concatMap((claim) => {
        if (claim.kind === 'replay') return of(claim.response);
        if (claim.kind === 'busy') return throwError(() => DomainError.conflict('This request is still being processed. Wait a moment and look again.'));
        if (claim.kind === 'mismatch') return throwError(() => new DomainError('VALIDATION_FAILED', 'This Idempotency-Key was already used for a different request.', 422));
        // The formula rule: an answer that holds a recipe's lines is never written down.
        const handler = typeof context.getHandler === 'function' ? context.getHandler() : undefined;
        const forget = !!handler && Reflect.getMetadata(META_NO_STORED_REPLY, handler) === true;
        return next.handle().pipe(
          concatMap((out) => from((forget ? this.store.release(userId, key) : this.store.complete(userId, key, out)).then(() => out))),
          catchError((err) => from(this.store.release(userId, key)).pipe(concatMap(() => throwError(() => err)))),
        );
      }),
    );
  }
}

/** The main API: platform.idempotency_key on DATABASE_URL. */
@Injectable()
export class IdempotencyInterceptor extends IdempotencyInterceptorBase {
  constructor(@Inject(PG_CLIENT) sql: Sql) { super(new IdempotencyStore(sql, 'platform.idempotency_key')); }
}

