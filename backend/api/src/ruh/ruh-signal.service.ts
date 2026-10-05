/**
 * RuhSignalService — C3, RawProd → ALEMBIC: `POST /api/v1/internal/rawprod/ruh/signal`, signed
 * exactly like the Aria forward (bridge/alembic-call.ts: the connector's sealed HMAC secret over
 * `${timestamp}.${nonce}.${rawBody}`, a fresh nonce per request, the tenant id in the body).
 *
 * DURABLE. Callers never talk to ALEMBIC: they enqueue into `bridge.ruh_signal` inside their own
 * transaction (an insight appearing, a person's override). The worker drains the queue every few
 * seconds, oldest first:
 *
 *   signals   `{ tenantId, signals: [C3Signal…] }`   — up to 25 per request
 *   resolves  `{ tenantId, resolved: [dedupeKey…] }` — up to 50 per request
 *
 * A 2xx marks the rows delivered. Anything else is retried with exponential backoff (2 s doubling,
 * capped at 30 minutes) FOR EVER — an unreachable, refusing or not-yet-upgraded ALEMBIC (a 404 while
 * its receiving route is being deployed) never loses a signal. Only a body ALEMBIC says is malformed
 * (400/413/415/422, or `permanent: true`) is parked: kept, counted on the Platform console, never
 * dropped. An unconfigured connector sends nothing and leaves everything queued.
 *
 * DEDUPE. While a row is pending there is one per (op, dedupeKey): enqueueing the same insight again
 * refreshes the pending payload instead of queueing a copy; a new signal for a key cancels a pending
 * resolve of it and a resolve cancels a pending signal (the last word wins, in order).
 */
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { ConfigService, PG_CLIENT } from '@core/backend-kernel';
import { BRIDGE_DB, type BridgeDb } from '../bridge/bridge.tokens.js';
import { alembicLink, signedBridgeHeaders } from '../bridge/alembic-call.js';
import type { C3Signal } from './ruh.contract.js';
import { isoOf } from '../pg-timestamp.js';

/** ALEMBIC's receiving route (lane ruh-watch), on the origin of the configured bridge webhook. */
export const ALEMBIC_RUH_SIGNAL_PATH = '/api/v1/internal/rawprod/ruh/signal';
/** Injection token for the transport — tests hand in a fake ALEMBIC. */
export const RUH_SIGNAL_FETCH = Symbol('RUH_SIGNAL_FETCH');

export const SIGNALS_PER_REQUEST = 25;
export const RESOLVES_PER_REQUEST = 50;
export const BACKOFF_CAP_SECONDS = 30 * 60;
const LEASE_SECONDS = 60;
const TIMEOUT_MS = 15_000;
const PERMANENT = new Set([400, 413, 415, 422]);

type Q = Sql | TransactionSql;

/** Seconds to wait after the `attempts`-th failure (1-based). */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** Math.max(1, attempts), BACKOFF_CAP_SECONDS);
}

/** Whether ALEMBIC's answer means "this body will never be accepted". */
export function isPermanentRefusal(status: number, body: unknown): boolean {
  const said = body && typeof body === 'object' ? (body as Record<string, unknown>).permanent : undefined;
  if (said === true) return true;
  if (said === false) return false;
  return PERMANENT.has(status);
}

interface DueRow { id: string; seq: string | number; op: 'signal' | 'resolve'; dedupe_key: string; payload: unknown; attempts: number }

export interface DrainResult { sent: number; failed: number; parked: number; state: 'ok' | 'not_configured' | 'idle' }

@Injectable()
export class RuhSignalService implements OnModuleDestroy {
  private readonly logger = new Logger(RuhSignalService.name);
  private readonly doFetch: typeof fetch;
  private draining = false;
  private stopped = false;

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Inject(BRIDGE_DB) private readonly bridgeDb: BridgeDb,
    @Inject(ConfigService) private readonly config: Pick<ConfigService, 'get'>,
    @Optional() @Inject(RUH_SIGNAL_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.doFetch = fetchImpl ?? fetch;
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  /* ── enqueue (inside the caller's transaction) ──────────────────────────────────────── */

  async enqueueSignal(q: Q, signal: C3Signal): Promise<void> {
    const payload = JSON.stringify(signal);
    await q`delete from bridge.ruh_signal where op = 'resolve' and dedupe_key = ${signal.dedupeKey}
              and delivered_at is null and parked_at is null`;
    await q`
      insert into bridge.ruh_signal (op, dedupe_key, payload)
      values ('signal', ${signal.dedupeKey}, ${payload}::text::jsonb)
      on conflict (op, dedupe_key) where delivered_at is null and parked_at is null
      do update set payload = excluded.payload, updated_at = now()`;
  }

  async enqueueResolve(q: Q, dedupeKey: string): Promise<void> {
    // A signal ALEMBIC never received needs no resolve; one it may have (a retry in flight) does.
    await q`delete from bridge.ruh_signal where op = 'signal' and dedupe_key = ${dedupeKey}
              and delivered_at is null and parked_at is null and attempts = 0`;
    await q`
      insert into bridge.ruh_signal (op, dedupe_key, payload)
      values ('resolve', ${dedupeKey}, null)
      on conflict (op, dedupe_key) where delivered_at is null and parked_at is null do nothing`;
  }

  /* ── drain (worker) ─────────────────────────────────────────────────────────────────── */

  /** Called by the worker's timer (RuhWorkerService). Never throws. */
  async tick(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      await this.drain();
    } catch (err) {
      this.logger.error(`ruh signal drain failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.draining = false;
    }
  }

  /** One pass over the due queue. Public so a test drives it without the timer. */
  async drain(): Promise<DrainResult> {
    const link = await alembicLink(this.bridgeDb, this.config.get('ALEMBIC_ASSERTION_TENANT_ID'), ALEMBIC_RUH_SIGNAL_PATH);
    if (!link) return { sent: 0, failed: 0, parked: 0, state: 'not_configured' };

    // Lease the due rows (oldest first) so a second drainer skips them while this one sends.
    const due = (await this.sql`
      update bridge.ruh_signal s set next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
       where s.ruh_signal_id in (
         select ruh_signal_id from bridge.ruh_signal
          where delivered_at is null and parked_at is null and next_attempt_at <= now()
          order by seq limit 200 for update skip locked)
      returning s.ruh_signal_id::text as id, s.seq, s.op, s.dedupe_key, s.payload, s.attempts`) as unknown as DueRow[];
    if (due.length === 0) return { sent: 0, failed: 0, parked: 0, state: 'idle' };
    due.sort((a, b) => Number(a.seq) - Number(b.seq));

    // Consecutive rows of one kind travel together, in order.
    const batches: DueRow[][] = [];
    for (const row of due) {
      const last = batches[batches.length - 1];
      const cap = row.op === 'signal' ? SIGNALS_PER_REQUEST : RESOLVES_PER_REQUEST;
      if (last && last[0]!.op === row.op && last.length < cap) last.push(row);
      else batches.push([row]);
    }

    const out: DrainResult = { sent: 0, failed: 0, parked: 0, state: 'ok' };
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const body = batch[0]!.op === 'signal'
        ? JSON.stringify({ tenantId: link.tenantId, signals: batch.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload)) })
        : JSON.stringify({ tenantId: link.tenantId, resolved: batch.map((r) => r.dedupe_key) });
      let status = 0;
      let answer: unknown;
      let network: string | null = null;
      try {
        const res = await this.doFetch(link.url, { method: 'POST', headers: signedBridgeHeaders(body, link.secret), body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        status = res.status;
        answer = await res.json().catch(() => undefined);
      } catch (err) {
        network = err instanceof Error ? err.message : String(err);
      }
      const ids = batch.map((r) => r.id);
      if (!network && status >= 200 && status < 300) {
        await this.sql`update bridge.ruh_signal set delivered_at = now(), last_http_status = ${status}, last_error = null, updated_at = now()
                        where ruh_signal_id = any(${`{${ids.join(',')}}`}::uuid[])`;
        out.sent += batch.length;
        continue;
      }
      const park = !network && isPermanentRefusal(status, answer);
      const error = network ? `network: ${network.slice(0, 200)}` : `http_${status}`;
      for (const r of batch) {
        const attempts = Number(r.attempts) + 1;
        await this.sql`
          update bridge.ruh_signal
             set attempts = ${attempts}, last_error = ${error}, last_http_status = ${network ? null : status},
                 next_attempt_at = now() + make_interval(secs => ${backoffSeconds(attempts)}),
                 parked_at = ${park ? 'now' : null}::timestamptz, updated_at = now()
           where ruh_signal_id = ${r.id}::uuid`;
      }
      if (park) out.parked += batch.length; else out.failed += batch.length;
      this.logger.warn(`ruh signals not delivered (${error})${park ? ' — parked' : ' — will retry'}`);
      if (!park) {
        // ALEMBIC is down or refusing: release the rest of this pass's lease so order holds next time.
        const rest = batches.slice(i + 1).flat().map((r) => r.id);
        if (rest.length) {
          await this.sql`update bridge.ruh_signal set next_attempt_at = now() + make_interval(secs => ${backoffSeconds(1)})
                          where ruh_signal_id = any(${`{${rest.join(',')}}`}::uuid[])`;
        }
        break;
      }
    }
    return out;
  }

  /** The queue at a glance (Platform console). Counts only. */
  async counts(): Promise<{ waiting: number; parked: number; delivered24h: number; oldestWaitingAt: string | null; lastError: string | null }> {
    const [r] = (await this.sql`
      select count(*) filter (where delivered_at is null and parked_at is null)::int as waiting,
             count(*) filter (where delivered_at is null and parked_at is not null)::int as parked,
             count(*) filter (where delivered_at > now() - interval '24 hours')::int as delivered24h,
             min(created_at) filter (where delivered_at is null and parked_at is null) as oldest,
             (select last_error from bridge.ruh_signal where delivered_at is null and last_error is not null order by updated_at desc limit 1) as last_error
        from bridge.ruh_signal`) as unknown as Array<{ waiting: number; parked: number; delivered24h: number; oldest: Date | string | null; last_error: string | null }>;
    return {
      waiting: Number(r?.waiting ?? 0), parked: Number(r?.parked ?? 0), delivered24h: Number(r?.delivered24h ?? 0),
      oldestWaitingAt: r?.oldest ? isoOf(r.oldest) : null, lastError: r?.last_error ?? null,
    };
  }
}
