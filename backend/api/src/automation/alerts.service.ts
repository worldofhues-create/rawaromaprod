/**
 * AutomationAlertsService — G3 rule: "QC HOLD age / overdue PR/PO → alert rows (existing alerts
 * mechanism)" (directive §46 automation law candidate "SLA escalation"; §19 human-approval gates
 * still require review — an alert row is a nudge, never an auto-decision).
 *
 * A time/threshold CONDITION, not an outbox event — the outbox can't express "this has been
 * sitting for N hours", so this runs on a periodic scan, the same shape EmailNotifierService's
 * `scan()` already uses (backend/api/src/notify/email-notifier.service.ts). It deliberately
 * REUSES that same table, `platform.notification_log`, rather than inventing a second alerts
 * store — "(existing alerts mechanism)" in the rule name. This module's rows are
 * complementary, not a replacement: EmailNotifierService already emails an immediate
 * `quality.qc.hold` notice and a daily PR+PO "approvals pending" digest; the two conditions
 * here are the AGE dimension neither of those covers — a QC HOLD that has sat unactioned past
 * a threshold, and a PR that has sat SUBMITTED past a threshold — each alerted once per
 * offending row, ever (not a repeating digest), via the shared `automation.applied` ledger so
 * it is exactly-once regardless of how many scan ticks see the same row. A distinct
 * `event_id` namespace (hashed from `rule_code:dedupe_key`) keeps this from ever colliding
 * with EmailNotifierService's own synthetic ids on the shared table.
 *
 * Write set: `platform.notification_log` (insert only — this module never mutates a PR/PO/QC
 * inspection's own state; it only raises the alert for a human to act on, per §19).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import {
  AUTOMATION_SCAN_MS,
  PR_OVERDUE_HOURS,
  QC_HOLD_ALERT_HOURS,
  PO_OVERDUE_HOURS,
  RULE,
  SYSTEM_ACTOR,
} from './automation.constants.js';
import { runIdempotent } from './ledger.js';
import { isoOf } from '../pg-timestamp.js';

@Injectable()
export class AutomationAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationAlertsService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.scan(), AUTOMATION_SCAN_MS);
    if (this.timer.unref) this.timer.unref();
    // First scan shortly after boot, same as EmailNotifierService's cadence.
    setTimeout(() => void this.scan(), 20000).unref?.();
    this.logger.log(`G3 alerts: scanning QC HOLD age / PR /PO overdue every ${AUTOMATION_SCAN_MS}ms`);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.scanQcHoldAge();
      await this.scanPrOverdue();
      await this.scanPoOverdue();
    } catch (err) {
      this.logger.warn(`automation alerts scan failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async scanQcHoldAge(): Promise<void> {
    const rows = (await this.sql`
      select qc_inspection_id::text as id, rm_batch_id::text as rm_batch_id, updated_dt
        from quality.qc_inspections
       where upper(overall_result) = 'HOLD'
         and updated_dt <= now() - (${QC_HOLD_ALERT_HOURS} || ' hours')::interval
       order by updated_dt asc
       limit 100
    `) as unknown as Array<{ id: string; rm_batch_id: string | null; updated_dt: Date | string }>;
    for (const r of rows) {
      await this.raise(
        RULE.ALERT_QC_HOLD_AGE,
        r.id,
        'quality.qc.hold_overdue',
        'ALERT',
        'role:qc',
        `QC HOLD unresolved for over ${QC_HOLD_ALERT_HOURS}h`,
        `Incoming QC inspection ${r.id} (RM batch ${r.rm_batch_id ?? 'unknown'}) has been on HOLD since ${isoOf(r.updated_dt)}, past the ${QC_HOLD_ALERT_HOURS}h threshold. Re-test or disposition it.`,
        { qcInspectionId: r.id, rmBatchId: r.rm_batch_id },
      );
    }
  }

  private async scanPrOverdue(): Promise<void> {
    const rows = (await this.sql`
      select purchase_request_id::text as id, pr_number, updated_dt
        from procurement.purchase_request
       where upper(status) = 'SUBMITTED'
         and updated_dt <= now() - (${PR_OVERDUE_HOURS} || ' hours')::interval
       order by updated_dt asc
       limit 100
    `) as unknown as Array<{ id: string; pr_number: string | null; updated_dt: Date | string }>;
    for (const r of rows) {
      await this.raise(
        RULE.ALERT_PR_OVERDUE,
        r.id,
        'procurement.pr.overdue',
        'ALERT',
        'role:procurement',
        `Purchase request pending approval > ${PR_OVERDUE_HOURS}h`,
        `Purchase request ${r.pr_number ?? r.id} has been SUBMITTED since ${isoOf(r.updated_dt)}, past the ${PR_OVERDUE_HOURS}h threshold, with no approval decision. Approve or reject it.`,
        { purchaseRequestId: r.id, prNumber: r.pr_number },
      );
    }
  }

  private async scanPoOverdue(): Promise<void> {
    const rows = (await this.sql`
      select purchase_order_id::text as id, po_number, updated_dt
        from procurement.purchase_order
       where upper(status) in ('DRAFT', 'PENDING', 'PENDING_APPROVAL')
         and updated_dt <= now() - (${PO_OVERDUE_HOURS} || ' hours')::interval
       order by updated_dt asc
       limit 100
    `) as unknown as Array<{ id: string; po_number: string | null; updated_dt: Date | string }>;
    for (const r of rows) {
      await this.raise(
        RULE.ALERT_PO_OVERDUE,
        r.id,
        'procurement.po.overdue',
        'ALERT',
        'role:procurement',
        `Purchase order awaiting approval > ${PO_OVERDUE_HOURS}h`,
        `Purchase order ${r.po_number ?? r.id} has been pending since ${isoOf(r.updated_dt)}, past the ${PO_OVERDUE_HOURS}h threshold. Approve, reject, or escalate it.`,
        { purchaseOrderId: r.id, poNumber: r.po_number },
      );
    }
  }

  /** One alert row per offending record, ever — dedupe via the shared idempotency ledger, same
   * "per-row alerts (one email per offending record, ever)" contract EmailNotifierService's
   * per-row conditions already use. */
  private async raise(
    ruleCode: string,
    entityId: string,
    eventType: string,
    channel: string,
    recipient: string,
    subject: string,
    body: string,
    inputs: Record<string, unknown>,
  ): Promise<void> {
    await runIdempotent({
      sql: this.sql,
      ruleCode,
      dedupeKey: entityId,
      eventType,
      aggregateId: null,
      inputs,
      work: async (tx) => {
        const eventId = this.syntheticId(`${ruleCode}:${entityId}`);
        await tx`
          insert into platform.notification_log
            (notification_log_id, event_id, event_type, channel, recipient, subject, body, status, created_dt, updated_dt)
          values (${randomUUID()}, ${eventId}, ${eventType}, ${channel}, ${recipient}, ${subject}, ${body}, 'LOGGED', now(), now())
          on conflict (event_id) do nothing
        `;
        return { decision: 'FIRED' as const, reason: subject, outputs: { eventId, actor: SYSTEM_ACTOR } };
      },
    });
  }

  /** Deterministic uuid from a string — same technique as EmailNotifierService.synthId, kept
   * distinct via the `rule_code:` prefix so this module's rows never collide with that
   * service's own synthetic ids on the shared `platform.notification_log.event_id` column. */
  private syntheticId(s: string): string {
    const h = createHash('md5').update(s).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }
}
