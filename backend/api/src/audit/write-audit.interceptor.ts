/**
 * WriteAuditInterceptor (OPS-GREEN Act I-M, lane ops-factory) — one append-only audit row for
 * every successful mutating request.
 *
 * Every cluster schema has shipped a `<schema>.audit_events` table since Phase 1 (data-kernel
 * `auditTable`), documented as "written by the backend audit interceptor on every mutating
 * request". No such interceptor existed: a full golden-journey run (PR, RFQ, PO, GRN, QC,
 * production, packaging, FG release) left every one of those tables EMPTY. The factory's only
 * trail was `created_by`/`updated_by` plus outbox events, which record what happened to a row,
 * not who asked for it or through which route.
 *
 * The row lands in the schema the route's own `@Permissions('<schema>:<table>:<verb>')` names,
 * so the audit follows the RBAC decision that admitted the request. `entity_type` is that
 * table; `action` is the route (`POST /v1/purchase-orders/:id/approve`); `entity_id` is the
 * `:id` param, else the table's own id in the response. Only a small `after` is kept (the
 * resulting `status`, when the response carries one): the audit trail says who did what to
 * which record, it never copies a record's contents (material identities stay where masking
 * already governs them). The Vault process never mounts this (its formula audit is the
 * hash-chained `formula.audit_events`, written by VaultService itself).
 *
 * Written after the handler's own transaction committed and before the response is sent, so a
 * caller that reads the trail right after a write sees it. A failed audit insert is logged at
 * error level and does not turn a committed write into a 500.
 */
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PG_CLIENT, type RequestWithUser } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { concatMap, type Observable } from 'rxjs';

const META_PERMISSIONS = 'core:permissions';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Schemas that carry an `audit_events` table the main API may append to. `formula` is the
 *  Vault's hash-chained trail and is never written from here. */
export const AUDITED_SCHEMAS = new Set([
  'iam', 'platform', 'masterdata', 'procurement', 'inventory', 'quality',
  'production', 'packaging', 'sales', 'bridge',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditRow {
  schema: string;
  entityType: string;
  action: string;
  entityId: string | null;
  after: Record<string, unknown> | null;
}

function camelId(table: string): string {
  return table.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()) + 'Id';
}

/** The table's own id somewhere in the first two levels of the handler's output. */
function findId(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const top = payload as Record<string, unknown>;
  if (typeof top[key] === 'string' && UUID.test(top[key] as string)) return top[key] as string;
  for (const v of Object.values(top)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = (v as Record<string, unknown>)[key];
      if (typeof inner === 'string' && UUID.test(inner)) return inner;
    }
  }
  return null;
}

/** Last resort: the first top-level `...Id` uuid in the handler's output. */
function firstTopLevelId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (k.endsWith('Id') && typeof v === 'string' && UUID.test(v)) return v;
  }
  return null;
}

function findStatus(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const top = payload as Record<string, unknown>;
  if (typeof top.status === 'string' && key in top) return top.status;
  for (const v of Object.values(top)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && key in (v as object)) {
      const s = (v as Record<string, unknown>).status;
      if (typeof s === 'string') return s;
    }
  }
  return typeof top.status === 'string' ? top.status : null;
}

/** Pure: what one mutating request should record, or null when it records nothing. */
export function auditRowFor(input: {
  method: string;
  route: string;
  permissions: readonly string[] | undefined;
  params: Record<string, unknown> | undefined;
  payload: unknown;
}): AuditRow | null {
  if (!MUTATING.has(input.method.toUpperCase())) return null;
  const perm = (input.permissions ?? []).find((p) => p.split(':').length === 3);
  if (!perm) return null;
  const [domain, table] = perm.split(':') as [string, string, string];
  const schema = AUDITED_SCHEMAS.has(domain) ? domain : 'platform';
  const entityType = schema === domain ? table : `${domain}.${table}`;
  const key = camelId(table);
  const shortKey = camelId(table.replace(/_(master|masters|details)$/, ''));
  const paramId = typeof input.params?.id === 'string' && UUID.test(input.params.id) ? input.params.id : null;
  const entityId = paramId ?? findId(input.payload, key) ?? findId(input.payload, shortKey)
    ?? firstTopLevelId(input.payload);
  const status = findStatus(input.payload, key);
  return {
    schema,
    entityType,
    action: `${input.method.toUpperCase()} ${input.route}`,
    entityId,
    after: status ? { status } : null,
  };
}

@Injectable()
export class WriteAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(WriteAuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(PG_CLIENT) private readonly sql: Sql,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<RequestWithUser & {
      params?: Record<string, unknown>; routeOptions?: { url?: string }; routerPath?: string;
    }>();
    const method = String(req.method ?? 'GET');
    if (!MUTATING.has(method.toUpperCase())) return next.handle();
    const permissions = this.reflector.getAllAndOverride<string[] | undefined>(META_PERMISSIONS, [
      context.getHandler(), context.getClass(),
    ]);
    const route = req.routeOptions?.url ?? req.routerPath ?? String(req.url ?? '').split('?')[0] ?? '';
    return next.handle().pipe(
      concatMap(async (payload) => {
        const row = auditRowFor({ method, route, permissions, params: req.params, payload });
        if (row) {
          try { await this.write(row, req); } catch (err) {
            this.logger.error(`audit row not written for ${row.action}: ${(err as Error).message}`);
          }
        }
        return payload;
      }),
    );
  }

  private async write(row: AuditRow, req: RequestWithUser): Promise<void> {
    const actor = req.user?.userId && UUID.test(req.user.userId) ? req.user.userId : null;
    await this.sql`
      insert into ${this.sql(row.schema)}.audit_events
        (actor_id, action, entity_type, entity_id, after, request_id, ip)
      values (${actor}, ${row.action}, ${row.entityType}, ${row.entityId},
              ${row.after ? this.sql.json(row.after as never) : null}, ${req.requestId ?? null}, ${req.ip ?? null})`;
  }
}
