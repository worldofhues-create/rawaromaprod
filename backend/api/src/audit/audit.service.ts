/**
 * AuditService — owner-facing governance views over the tamper-evident audit trail. The formula
 * vault writes a hash-chained row to formula.audit_events on every decrypt/access; this surfaces it
 * as a first-class "who accessed which formula, when, from where" report (the finding: the audit
 * existed at the crypto layer but had no route). Gated by `formula:actual:read` at the route.
 *
 * formula.audit_events lives in the VAULT database, not this box's (lane fread-rp: the old raw
 * SQL here read a table the production main DB does not have). The page comes from the Vault over
 * the signed internal channel (`VaultApiClient.accessAudit`); this box adds each actor's email from
 * its own iam.user_master, which the Vault has no copy of.
 *
 * loginHistory (lane F5, RP-DEADTABLES): NOT AVAILABLE. This used to query `iam.login_history` —
 * a table that does NOT exist in @core/data-iam or @ra/data-org (the only sources `pnpm db:push`
 * draws the `iam` schema from, per scripts/db-schema-groups.ts) and is not in the Phase-1A Data
 * Dictionary. Any real/dev database would 500 with "relation iam.login_history does not exist"
 * the instant this ran. Honest "not available" instead of a crash or fabricated data. (The write
 * side, cluster-org/src/auth/auth.service.ts#recordSession, is already best-effort/try-caught and
 * does not block login — left as-is; both sides need the table added before either is real.)
 * Unblocking it needs: `login_history` added to the Phase-1A dictionary + @core/data-iam (or
 * @ra/data-org) schema (columns as queried below), then db:push.
 */
import { Inject, Injectable, NotImplementedException, ServiceUnavailableException } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import { VaultApiClient, accessAuditBounds, type AccessAuditPage } from '@ra/cluster-formula';
import type { Sql } from 'postgres';
import { AUDITED_SCHEMAS } from './write-audit.interceptor.js';

@Injectable()
export class AuditService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    // Always bound in AppModule (VaultPortModule is global); optional only for tests that
    // exercise the main-database reads alone.
    @Inject(VaultApiClient) private readonly vault?: Pick<VaultApiClient, 'accessAudit'>,
  ) {}

  async formulaAccessAudit(limit = 100, cursor?: string): Promise<AccessAuditPage> {
    // Portal-audit WS1: offset-cursor paging so a growing audit trail is fully reachable (was
    // capped at the newest 100 with nextCursor:null). Offset is opaque to the client (meta.cursor);
    // acceptable for a time-desc governance browse where exact-consistency under concurrent writes
    // isn't required. Same bounds as always: limit 1..500, a malformed cursor reads as 0.
    const { limit: lim, offset } = accessAuditBounds(limit, cursor);
    if (!this.vault) throw new ServiceUnavailableException('The Formula Vault client is not configured on this box.');
    // section 109.6/109.8: each row carries the caller's decrypt reason + allow/refuse result
    // (VaultService.writeAudit's `after` snapshot, not part of the hash chain).
    const page = await this.vault.accessAudit(lim, String(offset));
    const actorIds = [...new Set(page.items.map((r) => r.actorId).filter((a): a is string => !!a))];
    const emails = new Map<string, string>();
    if (actorIds.length) {
      const users = await this.sql<{ user_id: string; email: string | null }[]>`
        select user_id::text as user_id, email from iam.user_master where user_id = any(${actorIds}::uuid[])`;
      for (const u of users) if (u.email) emails.set(u.user_id, u.email);
    }
    return {
      items: page.items.map((r) => ({ ...r, actor: (r.actorId && emails.get(r.actorId)) || null })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * GET /v1/audit-events (OPS-GREEN, lane ops-factory) — the write-audit trail every mutating
   * request now leaves (write-audit.interceptor.ts), across every cluster schema, newest first.
   * Filters: `entityId` (one record's history), `entityType` (one table), `action` (substring of
   * the route, e.g. `purchase-orders`). Offset cursor, same as formulaAccessAudit. Governance
   * read: `iam:audit_events:read` (owner + admin).
   */
  async listAuditEvents(q: { limit?: number; cursor?: string; entityId?: string; entityType?: string; action?: string }) {
    const lim = Math.min(Math.max(1, q.limit ?? 100), 500);
    const offset = Math.max(0, parseInt(q.cursor || '0', 10) || 0);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const entityId = q.entityId && uuid.test(q.entityId) ? q.entityId : null;
    const entityType = q.entityType ? String(q.entityType).slice(0, 120) : null;
    const action = q.action ? `%${String(q.action).slice(0, 120)}%` : null;
    // Only schemas whose audit_events table actually exists on this database (a schema group
    // that was never provisioned must not turn the whole governance read into a 500).
    const present = (await this.sql<{ s: string }[]>`
      select s from unnest(${[...AUDITED_SCHEMAS]}::text[]) as s
       where to_regclass(s || '.audit_events') is not null`).map((r) => r.s);
    if (present.length === 0) return { items: [], nextCursor: null };
    const parts = present.map((schema) => this.sql`
      select ${schema}::text as "cluster", ae.id, ae.action, ae.entity_type as "entityType",
             ae.entity_id as "entityId", ae.actor_id as "actorId", ae.after ->> 'status' as "resultStatus",
             ae.request_id as "requestId", ae.occurred_at as "occurredAt"
        from ${this.sql(schema)}.audit_events ae
       where (${entityId}::uuid is null or ae.entity_id = ${entityId}::uuid)
         and (${entityType}::text is null or ae.entity_type = ${entityType}::text)
         and (${action}::text is null or ae.action ilike ${action}::text)`);
    let union = parts[0]!;
    for (const p of parts.slice(1)) union = this.sql`${union} union all ${p}`;
    const items = await this.sql`
      select t.*, u.email as "actor"
        from (${union}) t
        left join iam.user_master u on u.user_id = t."actorId"
       order by t."occurredAt" desc, t.id desc
       limit ${lim} offset ${offset}`;
    return { items, nextCursor: items.length === lim ? String(offset + lim) : null };
  }

  async loginHistory(_limit = 100, _cursor?: string): Promise<never> {
    throw new NotImplementedException(
      'Login history is not available: its backing table (iam.login_history) was never added to the Phase-1A Data Dictionary or @core/data-iam / @ra/data-org schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }
}
