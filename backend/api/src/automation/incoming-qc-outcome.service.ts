/**
 * IncomingQcOutcomeService — G3 rule: "QC PASS on incoming → batch released to available;
 * FAIL → rejected, vendor credit note/return draft" (directive §18 "QC": `PASS → release
 * inventory` / `FAIL → rework/reject/return path`).
 *
 * Consumes `quality.qc.passed` / `quality.qc.failed` (InspectionsService.dispose —
 * backend/cluster-quality/src/inspections/inspections.service.ts, emitted on ACCEPT/REJECT
 * disposition) from `quality.outbox`. Dedupe key = qcInspectionId (the aggregate_id
 * `recordOutbox` was called with).
 *
 * PASS: projects the quarantined RM batch into the live ledger — creates an
 * `inventory.inventory_batch` (quantity = the batch's received qty) + an
 * `inventory.inventory_event_history` RECEIVE row, then flips `rm_batch_master.status` to
 * RELEASED. Mirrors BatchService.releaseRmBatch's shape (backend/cluster-inventory/src/batch/
 * batch.service.ts) — the same operator-triggered flow, now fired automatically off the QC
 * signal instead of waiting for someone to click "Release to stock".
 *
 * FAIL: flips `rm_batch_master.status` to REJECTED and drafts a
 * `procurement.vendor_credit_note` (status DRAFT — never auto-sent/auto-approved; a human
 * reviews and finalises it) against the vendor resolved via
 * rm_batch_master → grn_items → grn_master.vendor_id. If no GRN/vendor link exists (batch
 * wasn't created off a GRN), the batch is still rejected but no credit note is fabricated.
 *
 * Write set: `inventory.rm_batch_master` (status), `inventory.inventory_batch` (insert),
 * `inventory.inventory_event_history` (insert), `procurement.vendor_credit_note` (insert),
 * `procurement.vendor_credit_reason_master` (insert-if-missing, one fixed reason row).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql, TransactionSql } from 'postgres';
import { AUTOMATION_POLL_MS, RULE, SYSTEM_ACTOR, autoNumberSuffix } from './automation.constants.js';
import { runIdempotent } from './ledger.js';

const PASSED = 'quality.qc.passed';
const FAILED = 'quality.qc.failed';
const CREDIT_REASON_CODE = 'QC_REJECTION';

interface RmBatchRow {
  rm_batch_id: string;
  material_id: string | null;
  storage_location_id: string | null;
  uom_id: string | null;
  received_qty: string | null;
  grn_item_id: string | null;
}

@Injectable()
export class IncomingQcOutcomeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IncomingQcOutcomeService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), AUTOMATION_POLL_MS);
    if (this.timer.unref) this.timer.unref();
    this.logger.log(`G3 incoming-qc-outcome: polling ${PASSED}/${FAILED} every ${AUTOMATION_POLL_MS}ms`);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = (await this.sql`
        select o.aggregate_id::text as qc_inspection_id, o.type, o.payload
          from quality.outbox o
         where o.type in (${PASSED}, ${FAILED})
           and o.aggregate_id is not null
           and not exists (
             select 1 from automation.applied a
              where a.rule_code = ${this.ruleCodeFor(PASSED)} and a.dedupe_key = o.aggregate_id::text
                and a.status = 'DONE'
           )
           and not exists (
             select 1 from automation.applied a
              where a.rule_code = ${this.ruleCodeFor(FAILED)} and a.dedupe_key = o.aggregate_id::text
                and a.status = 'DONE'
           )
         order by o.occurred_at asc
         limit 50
      `) as unknown as Array<{ qc_inspection_id: string; type: string; payload: unknown }>;
      for (const r of rows) await this.applyOne(r.qc_inspection_id, r.type, r.payload);
    } catch (err) {
      this.logger.warn(`incoming-qc-outcome drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private ruleCodeFor(eventType: string): string {
    return eventType === PASSED ? RULE.INCOMING_QC_PASS : RULE.INCOMING_QC_FAIL;
  }

  private async applyOne(qcInspectionId: string, eventType: string, rawPayload: unknown): Promise<void> {
    const payload = (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload) as {
      rmBatchId?: string;
    };
    const rmBatchId = payload?.rmBatchId;
    if (!rmBatchId) return; // malformed event — nothing to key off; not retried (no dedupe key)

    const ruleCode = this.ruleCodeFor(eventType);
    await runIdempotent({
      sql: this.sql,
      ruleCode,
      dedupeKey: qcInspectionId,
      eventType,
      aggregateId: qcInspectionId,
      inputs: { qcInspectionId, rmBatchId },
      work: async (tx) =>
        eventType === PASSED ? this.applyPass(tx, rmBatchId) : this.applyFail(tx, rmBatchId, qcInspectionId),
    });
  }

  private async applyPass(tx: TransactionSql, rmBatchId: string) {
    const batch = (await tx`
      select rm_batch_id, material_id, storage_location_id, uom_id, received_qty, grn_item_id
        from inventory.rm_batch_master
       where rm_batch_id = ${rmBatchId} and status = 'QUARANTINE'
       for update
    `) as unknown as RmBatchRow[];
    const row = batch[0];
    if (!row) {
      return { decision: 'SKIPPED' as const, reason: 'RM batch is not QUARANTINE (already released/rejected, or never quarantined)' };
    }

    const inventoryBatchId = uuidv7();
    await tx`
      insert into inventory.inventory_batch
        (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status, created_by, updated_by)
      values (${inventoryBatchId}, ${rmBatchId}, ${row.material_id}, ${row.storage_location_id}, ${row.received_qty}, ${row.uom_id}, 'ACTIVE', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
    `;
    await tx`
      insert into inventory.inventory_event_history
        (inventory_batch_id, event_type, event_dt, reference_document_id, reference_document_type, event_qty, remarks, status, created_by, updated_by)
      values (${inventoryBatchId}, 'RECEIVE', now(), ${rmBatchId}, 'RM_BATCH', ${row.received_qty}, 'released to stock on incoming QC PASS (automation:g3)', 'ACTIVE', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
    `;
    await tx`
      update inventory.rm_batch_master set status = 'RELEASED', updated_by = ${SYSTEM_ACTOR}
       where rm_batch_id = ${rmBatchId}
    `;

    return {
      decision: 'FIRED' as const,
      reason: 'QC PASS: RM batch released to available stock',
      outputs: { inventoryBatchId },
    };
  }

  private async applyFail(tx: TransactionSql, rmBatchId: string, qcInspectionId: string) {
    const batch = (await tx`
      select rm_batch_id, grn_item_id
        from inventory.rm_batch_master
       where rm_batch_id = ${rmBatchId} and status = 'QUARANTINE'
       for update
    `) as unknown as RmBatchRow[];
    const row = batch[0];
    if (!row) {
      return { decision: 'SKIPPED' as const, reason: 'RM batch is not QUARANTINE (already released/rejected, or never quarantined)' };
    }

    await tx`update inventory.rm_batch_master set status = 'REJECTED', updated_by = ${SYSTEM_ACTOR} where rm_batch_id = ${rmBatchId}`;

    if (!row.grn_item_id) {
      return {
        decision: 'FIRED' as const,
        reason: 'QC FAIL: RM batch rejected; no GRN link — vendor credit note not drafted',
        outputs: { creditNoteId: null },
      };
    }

    const grn = (await tx`
      select g.vendor_id, g.grn_id
        from inventory.grn_items gi
        join inventory.grn_master g on g.grn_id = gi.grn_id
       where gi.grn_item_id = ${row.grn_item_id}
       limit 1
    `) as unknown as Array<{ vendor_id: string | null; grn_id: string }>;
    const vendorId = grn[0]?.vendor_id ?? null;
    const grnId = grn[0]?.grn_id ?? null;

    if (!vendorId) {
      return {
        decision: 'FIRED' as const,
        reason: 'QC FAIL: RM batch rejected; GRN has no vendor — vendor credit note not drafted',
        outputs: { creditNoteId: null },
      };
    }

    const reason = (await tx`
      insert into procurement.vendor_credit_reason_master (reason_code, reason_description, status, created_by, updated_by)
      values (${CREDIT_REASON_CODE}, 'Incoming QC rejection (automated)', 'ACTIVE', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
      on conflict (reason_code) do update set reason_code = excluded.reason_code
      returning vendor_credit_reason_id
    `) as unknown as Array<{ vendor_credit_reason_id: string }>;
    const reasonId = reason[0]?.vendor_credit_reason_id;

    /* THE AMOUNT (golden journey lane/j2). The draft used to carry amount = NULL, so the
     * reviewer had to go and look up what the rejected material had cost. The rejected batch's
     * received quantity x the PO line's rate is the value the vendor is being asked to credit —
     * computed, never guessed: when the GRN line has no PO line or the PO line no rate, the
     * amount stays NULL for the human to fill, exactly as before. Still a DRAFT either way. */
    const priced = (await tx`
      select (rb.received_qty * poi.rate)::numeric(18,4) as amount
        from inventory.rm_batch_master rb
        join inventory.grn_items gi on gi.grn_item_id = rb.grn_item_id
        join procurement.purchase_order_items poi on poi.purchase_order_item_id = gi.purchase_order_item_id
       where rb.rm_batch_id = ${rmBatchId}
         and rb.received_qty is not null and poi.rate is not null
       limit 1
    `) as unknown as Array<{ amount: string | null }>;
    const amount = priced[0]?.amount ?? null;

    const creditNoteId = uuidv7();
    const creditNoteNumber = `CN-AUTO-${autoNumberSuffix(creditNoteId)}`;
    await tx`
      insert into procurement.vendor_credit_note
        (vendor_credit_note_id, vendor_id, grn_id, vendor_credit_reason_id, credit_note_number, credit_note_date, amount, status, created_by, updated_by)
      values (${creditNoteId}, ${vendorId}, ${grnId}, ${reasonId ?? null}, ${creditNoteNumber}, current_date, ${amount}, 'DRAFT', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
    `;

    return {
      decision: 'FIRED' as const,
      reason: `QC FAIL: RM batch rejected; vendor credit note drafted (inspection ${qcInspectionId})`,
      outputs: { creditNoteId, vendorId, amount },
    };
  }
}
