/**
 * AuditService — owner-facing governance views over the tamper-evident audit trail. The formula
 * vault writes a hash-chained row to formula.audit_events on every decrypt/access; this surfaces it
 * as a first-class "who accessed which formula, when, from where" report (the finding: the audit
 * existed at the crypto layer but had no route). Login history reads iam.login_history. Raw SQL, owner-gated.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

@Injectable()
export class AuditService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async formulaAccessAudit(limit = 100) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select ae.id, ae.action, ae.entity_type as "entityType", ae.entity_id as "entityId",
             ae.actor_id as "actorId", u.email as "actor", ae.ip, ae.request_id as "requestId",
             ae.occurred_at as "occurredAt"
      from formula.audit_events ae
      left join iam.user_master u on u.user_id = ae.actor_id
      order by ae.occurred_at desc
      limit ${lim}`;
    return { items, nextCursor: null };
  }

  async loginHistory(limit = 100) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select s.id, u.email as "user", u.user_name as "userName", s.portal_audience as "portal",
             s.login_at as "loginAt", s.expires_at as "expiresAt"
      from iam.login_history s
      left join iam.user_master u on u.user_id = s.user_id
      order by s.login_at desc
      limit ${lim}`;
    return { items, nextCursor: null };
  }
}
