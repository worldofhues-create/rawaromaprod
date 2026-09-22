/**
 * AuditService — owner-facing governance views over the tamper-evident audit trail. The formula
 * vault writes a hash-chained row to formula.audit_events on every decrypt/access; this surfaces it
 * as a first-class "who accessed which formula, when, from where" report (the finding: the audit
 * existed at the crypto layer but had no route). Raw SQL, owner-gated.
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
import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

@Injectable()
export class AuditService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async formulaAccessAudit(limit = 100, cursor?: string) {
    const lim = Math.min(Math.max(1, limit), 500);
    // Portal-audit WS1: offset-cursor paging so a growing audit trail is fully reachable (was
    // capped at the newest 100 with nextCursor:null). Offset is opaque to the client (meta.cursor);
    // acceptable for a time-desc governance browse where exact-consistency under concurrent writes
    // isn't required.
    const offset = Math.max(0, parseInt(cursor || '0', 10) || 0);
    const items = await this.sql`
      select ae.id, ae.action, ae.entity_type as "entityType", ae.entity_id as "entityId",
             ae.actor_id as "actorId", u.email as "actor", ae.ip, ae.request_id as "requestId",
             ae.occurred_at as "occurredAt"
      from formula.audit_events ae
      left join iam.user_master u on u.user_id = ae.actor_id
      order by ae.occurred_at desc
      limit ${lim} offset ${offset}`;
    return { items, nextCursor: items.length === lim ? String(offset + lim) : null };
  }

  async loginHistory(_limit = 100, _cursor?: string): Promise<never> {
    throw new NotImplementedException(
      'Login history is not available: its backing table (iam.login_history) was never added to the Phase-1A Data Dictionary or @core/data-iam / @ra/data-org schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }
}
