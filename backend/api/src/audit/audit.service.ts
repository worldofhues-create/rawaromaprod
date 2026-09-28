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
 * loginHistory: every sign-in attempt on this deployment, successful or refused, newest first, from
 * iam.login_history (scripts/migrations/2026-09-28-login-history.sql; written by cluster-org's
 * AuthService at the ALEMBIC SSO exchange (factory, platform and the Vault console's step-up) and
 * the retired password door). Gated by `iam:user_master:read` at the route.
 */
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
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

  /**
   * GET /v1/login-history — one row per sign-in attempt, newest first, offset-cursor paged like
   * the other governance reads (limit 1..500; a malformed cursor reads as 0). Each row carries the
   * raw fields plus display-ready `when` / `who` / `how` / `result` so every console renders the
   * same words. `email` falls back to the account's current email when the attempt recorded none.
   * Parameters are bound as text — PG_CLIENT is the Drizzle-wrapped pool.
   */
  async loginHistory(limit = 100, cursor?: string) {
    const lim = Math.min(Math.max(1, Math.trunc(Number(limit)) || 100), 500);
    const offset = Math.max(0, parseInt(cursor || '0', 10) || 0);
    const rows = await this.sql<LoginHistoryRow[]>`
      select lh.login_history_id::text as "loginHistoryId",
             to_char(lh.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "when",
             lh.user_id::text as "userId", coalesce(lh.email, u.email) as "email", u.user_name as "userName",
             lh.method, lh.console, lh.outcome, lh.reason_code as "reasonCode", lh.reason,
             lh.ip, lh.user_agent as "userAgent", lh.session_id::text as "sessionId"
        from iam.login_history lh
        left join iam.user_master u on u.user_id = lh.user_id
       order by lh.occurred_at desc, lh.login_history_id desc
       limit ${String(lim)}::int offset ${String(offset)}::int`;
    const items = rows.map((r) => ({
      ...r,
      who: r.email || r.userName || 'Unknown',
      how: signInMethodLabel(r.method, r.console),
      result: r.outcome === 'SUCCESS' ? 'Success' : `Refused: ${r.reason || r.reasonCode || 'no reason given'}`,
    }));
    return { items, nextCursor: items.length === lim ? String(offset + lim) : null };
  }

}

interface LoginHistoryRow {
  loginHistoryId: string; when: string; userId: string | null; email: string | null; userName: string | null;
  method: string; console: string | null; outcome: string; reasonCode: string | null; reason: string | null;
  ip: string | null; userAgent: string | null; sessionId: string | null;
}

const CONSOLE_LABEL: Record<string, string> = { factory: 'Factory', platform: 'Platform', vault: 'Vault' };

/** "ALEMBIC SSO · Factory", "Vault step-up", "Password" — the words the consoles show in "How". */
export function signInMethodLabel(method: string, console: string | null): string {
  if (method === 'VAULT_STEP_UP') return 'Vault step-up';
  if (method === 'PASSWORD') return 'Password';
  const where = console ? CONSOLE_LABEL[console] ?? console : null;
  return where ? `ALEMBIC SSO · ${where}` : 'ALEMBIC SSO';
}
