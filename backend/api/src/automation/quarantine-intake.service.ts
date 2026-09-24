/**
 * QuarantineIntakeService — G3 rule: "GRN posted → RM batch in QUARANTINE + incoming QC
 * inspection created" (directive §18 "Receiving": `GRN → RM batch → quarantine if QC
 * required`; §18 "QC": `PASS → release inventory / HOLD → remain unavailable / FAIL →
 * rework/reject/return`).
 *
 * Consumes `inventory.batch.created` (emitted once per RM batch by GrnService.createGrn —
 * backend/cluster-inventory/src/grn/grn.service.ts) via the same cross-schema outbox-poll
 * idiom ConsumptionService already uses. Every RM batch is born `status = 'ACTIVE'`
 * (unquarantined) today — nothing currently blocks it from being released before QC has ever
 * looked at it. This rule closes that gap deterministically: it flips the batch to
 * `QUARANTINE` and opens a `PENDING` `quality.qc_inspections` row against it, in ONE
 * transaction, so a batch is never simultaneously "available" and "never inspected".
 *
 * Write set (the system actor's minimal surface for this rule): `inventory.rm_batch_master`
 * (status only, guarded to the ACTIVE→QUARANTINE transition — never touches a batch QC has
 * already moved past), and INSERTs into `quality.qc_inspections`. Nothing else.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { AUTOMATION_POLL_MS, RULE, SYSTEM_ACTOR } from './automation.constants.js';
import { runIdempotent } from './ledger.js';

const EVENT_TYPE = 'inventory.batch.created';

@Injectable()
export class QuarantineIntakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuarantineIntakeService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), AUTOMATION_POLL_MS);
    if (this.timer.unref) this.timer.unref();
    this.logger.log(`G3 quarantine-intake: polling ${EVENT_TYPE} every ${AUTOMATION_POLL_MS}ms`);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = (await this.sql`
        select o.aggregate_id::text as rm_batch_id
          from inventory.outbox o
         where o.type = ${EVENT_TYPE}
           and o.aggregate_id is not null
           and not exists (
             select 1 from automation.applied a
              where a.rule_code = ${RULE.QUARANTINE_INTAKE} and a.dedupe_key = o.aggregate_id::text
                and a.status = 'DONE'
           )
         order by o.occurred_at asc
         limit 50
      `) as unknown as Array<{ rm_batch_id: string }>;
      for (const r of rows) await this.applyOne(r.rm_batch_id);
    } catch (err) {
      this.logger.warn(`quarantine-intake drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async applyOne(rmBatchId: string): Promise<void> {
    await runIdempotent({
      sql: this.sql,
      ruleCode: RULE.QUARANTINE_INTAKE,
      dedupeKey: rmBatchId,
      eventType: EVENT_TYPE,
      aggregateId: rmBatchId,
      inputs: { rmBatchId },
      work: async (tx) => {
        // Guard: only act on a batch still in its just-received state. A batch QC/receiving
        // already moved past (RELEASED/REJECTED/QUARANTINE from a prior run) is left alone —
        // this is also what makes the rule safe under true concurrent duplicate delivery: the
        // UPDATE re-reads committed state at statement start, so only ONE concurrent caller's
        // WHERE status='ACTIVE' actually matches.
        const updated = (await tx`
          update inventory.rm_batch_master
             set status = 'QUARANTINE', updated_by = ${SYSTEM_ACTOR}
           where rm_batch_id = ${rmBatchId} and status = 'ACTIVE'
           returning rm_batch_id, material_id
        `) as unknown as Array<{ rm_batch_id: string; material_id: string | null }>;

        if (updated.length === 0) {
          return { decision: 'SKIPPED', reason: 'RM batch is not in ACTIVE status (already progressed by another flow)' };
        }

        const qcInspectionId = randomUUID();
        await tx`
          insert into quality.qc_inspections
            (qc_inspection_id, rm_batch_id, overall_result, status, created_by, updated_by)
          values (${qcInspectionId}, ${rmBatchId}, 'PENDING', 'PENDING', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
        `;

        return {
          decision: 'FIRED',
          reason: 'RM batch quarantined pending incoming QC; inspection opened',
          outputs: { qcInspectionId, materialId: updated[0]?.material_id ?? null },
        };
      },
    });
  }
}
