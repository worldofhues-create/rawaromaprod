/**
 * EmailNotifierService — Module 12 email half. Runs in the worker process. Two loops:
 *   (1) drain()  — polls every cluster's transactional outbox for notification-worthy domain events,
 *                  ROUTES each to the responsible role(s), renders a human email with a portal link +
 *                  what-to-do, dispatches via EmailTransport, records platform.notification_log
 *                  (idempotent on the outbox event id).
 *   (2) scan()   — periodically checks time/threshold CONDITIONS the outbox can't express (low stock,
 *                  expiry, pending-approval reminders, inbound QC HOLD, ≥₹25k PO stuck ≥24h) and
 *                  emails the responsible role. Deduped via a deterministic synthetic event id
 *                  (daily bucket for digests, per-row for per-item alerts) so it never spams.
 *
 * ROUTING vs DELIVERY: the log records the INTENDED recipients (the right role's users) so the
 * routing is auditable. Actual delivery goes to NOTIFY_TO when set (a single verified inbox — the
 * demo/free-Resend constraint), otherwise to the resolved role emails. Once the owner verifies a
 * sending domain and gives the role users real addresses, unset NOTIFY_TO and it delivers directly.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { EmailTransport } from './email-transport.service.js';

/** event type → { subject, roles, cta }. roles = who is responsible for acting on it. */
const RULES: Record<string, { subject: string; roles: string[]; cta: string; screen: string }> = {
  'quality.qc.failed':        { subject: 'QC FAILED — batch needs attention', roles: ['qc', 'owner'], cta: 'Review the failed inspection and disposition (reject / rework).', screen: 'Test queue' },
  'quality.qc.hold':          { subject: 'QC HOLD — batch quarantined', roles: ['qc', 'owner'], cta: 'Re-test or disposition the held batch (accept / reject / rework).', screen: 'Test queue' },
  'quality.qc.rework':        { subject: 'QC REWORK — batch needs reprocessing', roles: ['qc', 'production', 'owner'], cta: 'Reprocess/rework the batch, then re-inspect it.', screen: 'Test queue' },
  'procurement.po.issued':    { subject: 'Purchase order issued', roles: ['procurement', 'owner'], cta: 'Track vendor acknowledgement and expected dispatch.', screen: 'Purchase orders' },
  'procurement.pr.submitted': { subject: 'Purchase request awaiting approval', roles: ['procurement', 'owner'], cta: 'Approve or reject the purchase request.', screen: 'Purchase requests' },
  'formula.version.approved': { subject: 'Formula version approved & sealed', roles: ['owner'], cta: 'The version is now locked for production use.', screen: 'Formula versions' },
  'sales.order.confirmed':    { subject: 'Sales order confirmed', roles: ['sales', 'owner'], cta: 'Allocate stock and plan dispatch before the delivery deadline.', screen: 'Sales orders' },
  'sales.dispatch.created':   { subject: 'Dispatch created', roles: ['sales', 'owner'], cta: 'Assign transporter and confirm delivery.', screen: 'Dispatches' },
  'packaging.fg_batch.created': { subject: 'Finished-goods batch released', roles: ['packaging', 'warehouse', 'owner'], cta: 'Put away to FG inventory and mark available for sale.', screen: 'Finished goods' },
  'inventory.grn.created':    { subject: 'Goods received (GRN raised)', roles: ['warehouse', 'qc', 'owner'], cta: 'Run incoming QC before releasing to stock.', screen: 'Goods receipt' },
};
const COND_TYPE = 'production.qc.recorded'; // only notify on FAIL/HOLD
const TYPES = [...Object.keys(RULES), COND_TYPE];
const SCHEMAS = ['procurement', 'quality', 'production', 'packaging', 'sales', 'formula', 'inventory'];

@Injectable()
export class EmailNotifierService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailNotifierService.name);
  private readonly notifyTo = process.env.NOTIFY_TO || '';           // single deliverable inbox (demo)
  private readonly ownerFallback = process.env.NOTIFY_OWNER || 'owner@rawaroma.local';
  private readonly portal = process.env.PORTAL_URL || 'https://raw-aroma-api-9jn6.vercel.app';
  private readonly pollMs = Number(process.env.NOTIFY_POLL_MS) || 5000;
  private readonly scanMs = Number(process.env.NOTIFY_SCAN_MS) || 900000; // 15 min
  private pollTimer?: NodeJS.Timeout;
  private scanTimer?: NodeJS.Timeout;
  private running = false;
  private scanning = false;
  private emailCache = new Map<string, { at: number; emails: string[] }>();

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly transport: EmailTransport,
  ) {}

  onModuleInit(): void {
    this.pollTimer = setInterval(() => void this.drain(), this.pollMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
    // first condition scan shortly after boot, then on the slower cadence
    setTimeout(() => void this.scan(), 30000).unref?.();
    this.scanTimer = setInterval(() => void this.scan(), this.scanMs);
    if (this.scanTimer.unref) this.scanTimer.unref();
    this.logger.log(`email notifier: outbox every ${this.pollMs}ms, condition scan every ${this.scanMs}ms`);
  }
  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
  }

  /** Resolve the active user emails for a set of role codes (60s cache). */
  private async emailsForRoles(roles: string[]): Promise<string[]> {
    const key = [...roles].sort().join(',');
    const hit = this.emailCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.emails;
    let emails: string[] = [];
    try {
      const rows = (await this.sql`
        select distinct u.email from iam.user_master u
        join iam.user_role_mapping urm on urm.user_id = u.user_id
        join iam.role_master r on r.role_id = urm.role_id
        where lower(r.role_code) = any(${roles}) and coalesce(u.is_active, true) = true and u.email is not null
      `) as Array<{ email: string }>;
      emails = rows.map((r) => r.email).filter(Boolean);
    } catch (e) {
      this.logger.warn(`role email lookup failed: ${(e as Error).message}`);
    }
    this.emailCache.set(key, { at: Date.now(), emails });
    return emails;
  }

  private body(subject: string, summary: string, facts: Record<string, unknown>, cta: string, screen: string): string {
    const factLines = Object.entries(facts)
      .filter(([, v]) => v != null && typeof v !== 'object' && String(v) !== '')
      .slice(0, 8)
      .map(([k, v]) => `  • ${k}: ${String(v)}`)
      .join('\n');
    return [
      subject,
      '',
      summary,
      factLines ? `\nDetails:\n${factLines}` : '',
      `\nWhat to do: ${cta}`,
      `Open the portal → ${this.portal}  (${screen})`,
      '',
      '— RAW AROMACHEM notifications',
    ].filter((l) => l !== null).join('\n');
  }

  /** Send + record. `intended` = the routed role emails (audit truth); delivery respects NOTIFY_TO. */
  private async deliver(eventId: string, eventType: string, subject: string, body: string, intended: string[]): Promise<void> {
    const intendedList = intended.length ? intended : [this.ownerFallback];
    const deliverTo = this.notifyTo ? [this.notifyTo] : intendedList;
    let result;
    try { result = await this.transport.send(deliverTo, subject, body); }
    catch (err) { result = { status: 'FAILED' as const, error: (err as Error).message }; }
    await this.sql`
      insert into platform.notification_log
        (notification_log_id, event_id, event_type, channel, recipient, subject, body, status, error, attempts, updated_dt)
      values (${randomUUID()}, ${eventId}, ${eventType}, 'email', ${intendedList.join(', ')}, ${subject}, ${body}, ${result.status}, ${(result as { error?: string }).error ?? null}, 1, now())
      on conflict (event_id) do update set
        status = excluded.status,
        error = excluded.error,
        attempts = platform.notification_log.attempts + 1,
        updated_dt = now()`;
  }

  /** Deterministic uuid from a string so condition alerts dedupe (daily bucket / per-row). */
  private synthId(s: string): string {
    const h = createHash('md5').update(s).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  // ---------------- (1) event-driven outbox drain ----------------
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const union = SCHEMAS.map((s) => `select id, type, payload::text as payload, occurred_at from ${s}.outbox`).join(' union all ');
      const inList = TYPES.map((t) => `'${t}'`).join(',');
      // Delivery-assurance (audit #10): re-process an event that hasn't been SENT/LOGGED yet and
      // still has retries left (FAILED with attempts < 3). A row that is SENT/LOGGED, or FAILED
      // after 3 attempts (dead-lettered), is excluded.
      const rows = (await this.sql.unsafe(
        `select id, type, payload, occurred_at from (${union}) e
         where e.type in (${inList})
           and not exists (
             select 1 from platform.notification_log nl
              where nl.event_id = e.id
                and (nl.status in ('SENT','LOGGED') or coalesce(nl.attempts,0) >= 3)
           )
         order by e.occurred_at desc limit 50`,
      )) as Array<{ id: string; type: string; payload: string | null }>;
      for (const r of rows) await this.notifyEvent(r);
    } catch (e) {
      this.logger.warn(`notifier drain failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async notifyEvent(r: { id: string; type: string; payload: string | null }): Promise<void> {
    let payload: Record<string, unknown> = {};
    try { payload = r.payload ? JSON.parse(r.payload) : {}; } catch { /* ignore */ }
    let rule = RULES[r.type];
    if (r.type === COND_TYPE) {
      const res = String(payload.result ?? '');
      if (!/FAIL|HOLD/i.test(res)) return;
      rule = { subject: `Production QC ${res.toUpperCase()} — action needed`, roles: ['qc', 'production', 'owner'], cta: 'Review the oil batch and decide rework / reject.', screen: 'Production QC' };
    }
    if (!rule) return;
    const intended = await this.emailsForRoles(rule.roles);
    const body = this.body(rule.subject, `A ${r.type} event needs the ${rule.roles.filter((x) => x !== 'owner').join('/') || 'owner'} team.`, payload, rule.cta, rule.screen);
    await this.deliver(r.id, r.type, rule.subject, body, intended);
  }

  // ---------------- (2) periodic condition scan ----------------
  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const day = new Date().toISOString().slice(0, 10);
    try {
      // -- daily digests (one email/day/condition while the condition holds) --
      const low = ((await this.sql`select count(*)::int c from procurement.stock_requirement where status is null or upper(status) <> 'CLOSED'`) as Array<{ c: number }>)[0] ?? { c: 0 };
      if (low.c > 0) {
        await this.condition(`lowstock:${day}`, 'stock.low', 'Low stock / reorder required',
          `${low.c} material(s) are below reorder level and need a purchase request.`, { openRequirements: low.c }, ['procurement', 'owner'],
          'Raise purchase requests for the short materials.', 'Stock planning');
      }
      const exp = ((await this.sql`select count(*)::int c, min(expiry_date)::text soonest from inventory.rm_batch_master where expiry_date is not null and expiry_date <= (now() + interval '30 days')`) as Array<{ c: number; soonest: string | null }>)[0] ?? { c: 0, soonest: null };
      if (exp.c > 0) {
        await this.condition(`expiry:${day}`, 'inventory.expiry', 'Expiry warning — RM batches expiring soon',
          `${exp.c} raw-material batch(es) expire within 30 days (soonest ${exp.soonest ?? '?'}). Use or quarantine them first (FEFO).`, { batchesExpiring: exp.c, soonest: exp.soonest }, ['warehouse', 'owner'],
          'Prioritise these batches for production or quarantine before expiry.', 'RM batches');
      }
      // Lane F5 (RP-DEADTABLES): platform.document_registry does NOT exist in @core/data-platform
      // or @ra/data-reference (db:push's only sources for `platform`) or the Phase-1A Data
      // Dictionary — see documents.service.ts. Isolated in its own try/catch (rather than left to
      // bubble to the outer catch below) because it used to run BEFORE the approvals/dead-letter/
      // stuck-PO/auto-approve/vendor-ack blocks further down: one missing table was silently
      // killing every real, working condition that runs after it in this function, every scan.
      try {
        const doc = ((await this.sql`select count(*)::int c, min(expiry_date)::text soonest from platform.document_registry where status = 'ACTIVE' and expiry_date is not null and expiry_date <= (now() + interval '45 days')`) as Array<{ c: number; soonest: string | null }>)[0] ?? { c: 0, soonest: null };
        if (doc.c > 0) {
          await this.condition(`docexpiry:${day}`, 'document.expiry', 'Document expiry — compliance docs lapsing soon',
            `${doc.c} document(s) (vendor licences / COAs / contracts) expire within 45 days (soonest ${doc.soonest ?? '?'}). Renew them before they lapse.`, { documentsExpiring: doc.c, soonest: doc.soonest }, ['admin', 'owner'],
            'Renew or replace the expiring documents.', 'Documents');
        }
      } catch (e) {
        this.logger.warn(`notifier scan: document-expiry digest skipped (platform.document_registry does not exist in any real database): ${(e as Error).message}`);
      }
      const appr = ((await this.sql`select
          (select count(*) from procurement.purchase_request where upper(status) = 'SUBMITTED')
        + (select count(*) from procurement.purchase_order where upper(status) in ('DRAFT','PENDING','PENDING_APPROVAL')) c`) as Array<{ c: number }>)[0] ?? { c: 0 };
      if (appr.c > 0) {
        await this.condition(`approvals:${day}`, 'workflow.approval.pending', 'Approvals waiting for sign-off',
          `${appr.c} purchase request(s)/order(s) are waiting for approval. Delays here stall procurement.`, { pending: appr.c }, ['procurement', 'owner'],
          'Review and approve/reject the pending items.', 'Purchase orders');
      }
      // Dead-letter alert (audit #10): notifications that failed after all retries.
      // Lane F5 (RP-DEADTABLES): platform.notification_log does NOT exist in @core/data-platform
      // or @ra/data-reference or the Phase-1A Data Dictionary either (the drain() writer below is
      // already best-effort/try-caught for the same reason). Isolated the same way as
      // document-expiry above, so it can't silently kill the stuck-PO/auto-approve/vendor-ack
      // blocks that follow it.
      try {
        const dead = ((await this.sql`select count(*)::int c from platform.notification_log where status = 'FAILED' and coalesce(attempts, 0) >= 3`) as Array<{ c: number }>)[0] ?? { c: 0 };
        if (dead.c > 0) {
          await this.condition(`notify-dead:${day}`, 'notify.dead_letter', 'Notification delivery is failing',
            `${dead.c} notification(s) could not be delivered after 3 attempts — check the email provider (RESEND_API_KEY / sending domain).`, { failed: dead.c }, ['admin', 'owner'],
            'Check the email provider configuration; the affected events can be re-triggered.', 'Notifications');
        }
      } catch (e) {
        this.logger.warn(`notifier scan: dead-letter check skipped (platform.notification_log does not exist in any real database): ${(e as Error).message}`);
      }
      // -- per-row alerts (one email per offending record, ever) --
      // (inbound QC HOLD now notifies immediately via the quality.qc.hold outbox event, not here.)
      const stuck = (await this.sql`select purchase_order_id id, po_number, total_amount::text total_amount, created_dt::text created_dt from procurement.purchase_order where upper(status) in ('DRAFT','PENDING','PENDING_APPROVAL') and total_amount >= 25000 and created_dt <= now() - interval '24 hours'`) as Array<Record<string, unknown>>;
      for (const p of stuck) {
        await this.condition(`po-escalate:${p.id}`, 'procurement.po.escalation', 'PO escalation — high-value order stuck >24h',
          `A purchase order ≥ ₹25,000 has been awaiting approval for over 24 hours and needs owner sign-off (it is above the auto-approve threshold).`, p, ['owner'],
          'Approve or reject this high-value purchase order.', 'Purchase orders');
      }

      // M04 rule (owner decision O5): PO < ₹25,000 pending > 24h → AUTO-APPROVE; ≥ ₹25k escalates (above).
      const autoApproved = (await this.sql`
        update procurement.purchase_order
           set status = 'APPROVED', updated_dt = now(), updated_by = 'auto-approve-24h'
         where upper(status) in ('DRAFT','PENDING','PENDING_APPROVAL')
           and total_amount < 25000 and created_dt <= now() - interval '24 hours'
         returning purchase_order_id id, po_number, total_amount::text total_amount`) as Array<Record<string, unknown>>;
      for (const p of autoApproved) {
        await this.condition(`po-autoapprove:${p.id}`, 'procurement.po.auto_approved', 'PO auto-approved (< ₹25k, > 24h)',
          `Purchase order ${String(p.po_number)} (₹${String(p.total_amount)}) was auto-approved after 24 hours per the ₹25,000 policy.`, p, ['procurement', 'owner'],
          'No approval needed — the PO is approved and can be issued.', 'Purchase orders');
      }

      // Vendor acknowledgement overdue — PO issued > 2 days ago, vendor hasn't acknowledged.
      const ackOverdue = (await this.sql`select purchase_order_id id, po_number from procurement.purchase_order where upper(status) = 'ISSUED' and updated_dt <= now() - interval '2 days'`) as Array<Record<string, unknown>>;
      for (const p of ackOverdue) {
        await this.condition(`po-ack:${p.id}`, 'procurement.po.ack_overdue', 'PO acknowledgement overdue',
          `PO ${String(p.po_number)} was issued more than 2 days ago and the vendor has not acknowledged it yet.`, p, ['procurement', 'owner'],
          'Chase the vendor for acknowledgement + expected dispatch date.', 'Purchase orders');
      }
    } catch (e) {
      this.logger.warn(`notifier scan failed: ${(e as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private async condition(dedupeKey: string, type: string, subject: string, summary: string, facts: Record<string, unknown>, roles: string[], cta: string, screen: string): Promise<void> {
    const intended = await this.emailsForRoles(roles);
    const body = this.body(subject, summary, facts, cta, screen);
    await this.deliver(this.synthId(dedupeKey), type, subject, body, intended);
  }
}
