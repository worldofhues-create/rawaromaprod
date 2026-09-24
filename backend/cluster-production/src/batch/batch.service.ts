/**
 * BatchService — oil batch genealogy + production QC: OIL_BATCH_MASTER, OIL_BATCH_CONSUMPTION,
 * OIL_BATCH_EVENT_HISTORY, PRODUCTION_QC, OIL_BATCH_QC_HISTORY. CRUD reads for all five, plus
 * two flows:
 *
 *   produceOilBatch  → in one tx inserts oil_batch_master + oil_batch_consumption rows (from
 *                      body.consumption) + an oil_batch_event_history (eventType PRODUCED), then
 *                      emits production.oil_batch.created.
 *   recordProductionQc → in one tx inserts production_qc + oil_batch_qc_history + an
 *                      oil_batch_event_history (eventType QC_RECORDED), then emits
 *                      production.qc.recorded.
 *
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; numerics via num();
 * ISO timestamps → Date. order/session/uom/user/parameter/document refs are id-only soft refs.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { emitBridgeOutbound, recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { productionEvents } from '../production.events.js';
import { paginate, num, type Page } from '../_helpers.js';
import type { ListQuery, ProduceOilBatch, RecordProductionQc } from '../production.dtos.js';

/** Maps a production-QC grade onto the bridge contract's `qc_status` vocabulary
 *  (docs/bridge/EVENT_CONTRACT.md): PASS → passed; FAIL/REJECT → failed; anything else
 *  (HOLD, an ungraded reading) → pending. Exported for its test. */
export function qcStatusForBridge(graded: string | null | undefined): 'passed' | 'failed' | 'pending' {
  const g = String(graded ?? '').toUpperCase();
  if (g === 'PASS' || g === 'ACCEPT') return 'passed';
  if (g === 'FAIL' || g === 'REJECT' || g === 'FAILED') return 'failed';
  return 'pending';
}

// Oil-batch lifecycle state machine (audit H-C6): the only legal moves. Was raw any→any status
// PATCH via the generic editor (client-side guards only) — an API caller could go FAILED→RELEASED.
const OIL_TRANSITIONS: Record<string, string[]> = {
  ACTIVE: ['IN_MATURATION', 'HOLD', 'FAILED'],
  PRODUCED: ['IN_MATURATION', 'HOLD', 'FAILED'],
  IN_MATURATION: ['RELEASED', 'HOLD', 'REWORK', 'FAILED'],
  MATURING: ['RELEASED', 'HOLD', 'REWORK', 'FAILED'],
  HOLD: ['IN_MATURATION', 'RELEASED', 'REWORK', 'FAILED'],
  REWORK: ['IN_MATURATION', 'RELEASED', 'FAILED'],
  RELEASED: [],
  FAILED: [],
};

const {
  oilBatchMaster,
  oilBatchConsumption,
  oilBatchEventHistory,
  productionQc,
  oilBatchQcHistory,
  outbox,
} = productionSchema;

@Injectable()
export class BatchService {
  constructor(@Inject(PRODUCTION_DB) private readonly db: ProductionDb) {}

  /* ── oil batch master (CRUD reads) ───────────────────────────────── */

  async listOilBatches(query: ListQuery): Promise<Page<typeof oilBatchMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(oilBatchMaster)
      .where(query.cursor ? lt(oilBatchMaster.oilBatchId, query.cursor) : undefined)
      .orderBy(desc(oilBatchMaster.oilBatchId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.oilBatchId);
  }

  async getOilBatch(id: string) {
    return (
      await this.db
        .select()
        .from(oilBatchMaster)
        .where(eq(oilBatchMaster.oilBatchId, id))
        .limit(1)
    )[0] ?? null;
  }

  async listConsumption(query: ListQuery): Promise<Page<typeof oilBatchConsumption.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(oilBatchConsumption)
      .where(
        query.cursor ? lt(oilBatchConsumption.oilBatchConsumptionId, query.cursor) : undefined,
      )
      .orderBy(desc(oilBatchConsumption.oilBatchConsumptionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.oilBatchConsumptionId);
  }

  async getConsumption(id: string) {
    return (
      await this.db
        .select()
        .from(oilBatchConsumption)
        .where(eq(oilBatchConsumption.oilBatchConsumptionId, id))
        .limit(1)
    )[0] ?? null;
  }

  async listEventHistory(
    query: ListQuery,
  ): Promise<Page<typeof oilBatchEventHistory.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(oilBatchEventHistory)
      .where(
        query.cursor ? lt(oilBatchEventHistory.oilBatchEventHistoryId, query.cursor) : undefined,
      )
      .orderBy(desc(oilBatchEventHistory.oilBatchEventHistoryId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.oilBatchEventHistoryId);
  }

  async getEventHistory(id: string) {
    return (
      await this.db
        .select()
        .from(oilBatchEventHistory)
        .where(eq(oilBatchEventHistory.oilBatchEventHistoryId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── flow: oil-batch lifecycle transition (guarded) ──────────────── */

  /**
   * POST /v1/oil-batches/:id/transition — move an oil batch to a new lifecycle state, but only
   * along a legal edge of OIL_TRANSITIONS. Writes an oil_batch_event_history row + emits
   * production.oil_batch.status, all in one transaction. Same-state is an idempotent no-op.
   *
   * RP-FAC: the write is a compare-and-swap — `UPDATE ... WHERE oil_batch_id = :id AND status =
   * :current` — not an unconditional update. Two concurrent transitions off the same source state
   * (e.g. two operators both firing ACTIVE→IN_MATURATION, or a double-click resubmit) used to both
   * pass the in-memory OIL_TRANSITIONS check (each read the same pre-transition `current`) and
   * both write, producing two event_history rows and two outbox events for one logical move. Under
   * Postgres read-committed, the second UPDATE now blocks on the first's row lock, re-evaluates
   * its WHERE clause against the just-committed new status, matches zero rows, and this throws —
   * exactly one of the two racing callers wins.
   */
  async transitionOilBatch(id: string, target: string, principal: AuthPrincipal) {
    const batch = await this.getOilBatch(id);
    if (!batch) throw new NotFoundException(`oil_batch_master not found: ${id}`);
    const current = String(batch.status ?? 'ACTIVE').toUpperCase();
    const tgt = String(target ?? '').toUpperCase();
    if (current === tgt) return batch; // idempotent
    if (!(OIL_TRANSITIONS[current] ?? []).includes(tgt)) {
      throw new ConflictException(`Oil batch cannot move from ${current} to ${tgt || '(none)'}.`);
    }
    /* Final-QC gate (golden journey lane/j2): RELEASED is the state packaging consumes, and it
     * was reachable with NO production QC on file at all — live, a matured batch went straight
     * to RELEASED. The latest QC reading recorded against the batch must be a PASS. */
    if (tgt === 'RELEASED') {
      const latest = (
        await this.db
          .select({ result: productionQc.result })
          .from(productionQc)
          .where(eq(productionQc.oilBatchId, id))
          .orderBy(desc(productionQc.productionQcId))
          .limit(1)
      )[0];
      if (String(latest?.result ?? '').toUpperCase() !== 'PASS') {
        throw new ConflictException(
          latest
            ? `Oil batch ${id} cannot be RELEASED: its latest QC result is ${latest.result ?? 'ungraded'}, not PASS.`
            : `Oil batch ${id} cannot be RELEASED: no QC result has been recorded against it (POST /v1/production-qc).`,
        );
      }
    }
    return this.db.transaction(async (tx) => {
      const updated = (
        await tx
          .update(oilBatchMaster)
          .set({ status: tgt, updatedBy: principal.userId })
          .where(and(eq(oilBatchMaster.oilBatchId, id), eq(oilBatchMaster.status, current)))
          .returning()
      )[0];
      if (!updated) {
        throw new ConflictException(
          `Oil batch ${id} was moved off ${current} by a concurrent request; refusing this stale ${current}→${tgt} transition.`,
        );
      }

      await tx.insert(oilBatchEventHistory).values({
        oilBatchEventHistoryId: uuidv7(),
        oilBatchId: id,
        eventType: tgt,
        eventDt: new Date(),
        performedBy: principal.userId,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      await recordOutbox(tx, outbox, productionEvents.oilBatchStatus, { oilBatchId: id, status: tgt }, id);
      return updated;
    });
  }

  /* ── flow: produce oil batch ─────────────────────────────────────── */

  /**
   * POST /v1/oil-batches — produce an oil batch. Inserts oil_batch_master + its consumption
   * genealogy + a PRODUCED event_history row, then emits production.oil_batch.created. All in
   * one transaction.
   */
  async produceOilBatch(body: ProduceOilBatch, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const batch = (
        await tx
          .insert(oilBatchMaster)
          .values({
            oilBatchId: uuidv7(),
            productionOrderId: body.productionOrderId,
            secureMixingSessionId: body.secureMixingSessionId ?? null,
            batchNumber: body.batchNumber,
            producedQty: num(body.producedQty),
            uomId: body.uomId ?? null,
            producedDt: body.producedDt ? new Date(body.producedDt) : new Date(),
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!batch) throw new Error('insert failed: oil_batch_master');

      const oilBatchId = batch.oilBatchId;

      for (const c of body.consumption ?? []) {
        await tx.insert(oilBatchConsumption).values({
          oilBatchConsumptionId: uuidv7(),
          oilBatchId,
          consumedForDocumentId: c.consumedForDocumentId ?? null,
          consumedQty: num(c.consumedQty),
          uomId: c.uomId ?? null,
          consumedDt: c.consumedDt ? new Date(c.consumedDt) : new Date(),
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
      }

      await tx.insert(oilBatchEventHistory).values({
        oilBatchEventHistoryId: uuidv7(),
        oilBatchId,
        eventType: 'PRODUCED',
        eventDt: new Date(),
        performedBy: principal.userId,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      await recordOutbox(
        tx,
        outbox,
        productionEvents.oilBatchCreated,
        { oilBatchId, productionOrderId: body.productionOrderId, batchNumber: body.batchNumber },
        oilBatchId,
      );

      return { batch, consumptionCount: (body.consumption ?? []).length };
    });
  }

  /* ── production QC (CRUD reads) ──────────────────────────────────── */

  async listQc(query: ListQuery): Promise<Page<typeof productionQc.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(productionQc)
      .where(query.cursor ? lt(productionQc.productionQcId, query.cursor) : undefined)
      .orderBy(desc(productionQc.productionQcId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.productionQcId);
  }

  async getQc(id: string) {
    return (
      await this.db
        .select()
        .from(productionQc)
        .where(eq(productionQc.productionQcId, id))
        .limit(1)
    )[0] ?? null;
  }

  async listQcHistory(query: ListQuery): Promise<Page<typeof oilBatchQcHistory.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(oilBatchQcHistory)
      .where(query.cursor ? lt(oilBatchQcHistory.oilBatchQcHistoryId, query.cursor) : undefined)
      .orderBy(desc(oilBatchQcHistory.oilBatchQcHistoryId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.oilBatchQcHistoryId);
  }

  async getQcHistory(id: string) {
    return (
      await this.db
        .select()
        .from(oilBatchQcHistory)
        .where(eq(oilBatchQcHistory.oilBatchQcHistoryId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── flow: record production QC ──────────────────────────────────── */

  /**
   * POST /v1/production-qc — record a QC reading against an oil batch. Inserts production_qc +
   * oil_batch_qc_history + a QC_RECORDED event_history row, then emits production.qc.recorded.
   * All in one transaction.
   */
  async recordProductionQc(body: RecordProductionQc, principal: AuthPrincipal) {
    // Auto-grade against the supplied spec range (audit #8): observed value inside [min,max] = PASS.
    const graded =
      (body.specMin != null || body.specMax != null) && body.observedValue != null
        ? (body.specMin == null || body.observedValue >= body.specMin) &&
          (body.specMax == null || body.observedValue <= body.specMax)
          ? 'PASS'
          : 'FAIL'
        : body.result ?? null;
    return this.db.transaction(async (tx) => {
      const qc = (
        await tx
          .insert(productionQc)
          .values({
            productionQcId: uuidv7(),
            oilBatchId: body.oilBatchId,
            qcParameterId: body.qcParameterId ?? null,
            observedValue: num(body.observedValue),
            result: graded,
            inspectedBy: body.inspectedBy ?? principal.userId,
            inspectionDt: body.inspectionDt ? new Date(body.inspectionDt) : new Date(),
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!qc) throw new Error('insert failed: production_qc');

      const productionQcId = qc.productionQcId;

      await tx.insert(oilBatchQcHistory).values({
        oilBatchQcHistoryId: uuidv7(),
        oilBatchId: body.oilBatchId,
        productionQcId,
        recordedDt: new Date(),
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      await tx.insert(oilBatchEventHistory).values({
        oilBatchEventHistoryId: uuidv7(),
        oilBatchId: body.oilBatchId,
        eventType: 'QC_RECORDED',
        eventDt: new Date(),
        performedBy: principal.userId,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      await recordOutbox(
        tx,
        outbox,
        productionEvents.qcRecorded,
        { productionQcId, oilBatchId: body.oilBatchId, result: graded },
        productionQcId,
      );

      // RP-EMIT (lane F6): resolve the order this oil batch was produced against, then emit
      // QcStatusChanged toward ALEMBIC iff that order fulfills a bridge requirement — same
      // transaction as the QC insert above.
      const orderRow = (
        await tx
          .select({ productionOrderId: oilBatchMaster.productionOrderId })
          .from(oilBatchMaster)
          .where(eq(oilBatchMaster.oilBatchId, body.oilBatchId))
          .limit(1)
      )[0];
      await emitBridgeOutbound(tx, 'QcStatusChanged', orderRow?.productionOrderId, {
        production_qc_id: productionQcId,
        oil_batch_id: body.oilBatchId,
        result: graded,
        // docs/bridge/EVENT_CONTRACT.md: `{ qc_status: "pending"|"passed"|"failed" }` — the one
        // field ALEMBIC's transitionRequirement reads. Emitting only `result` (golden journey,
        // lane/j2) made ALEMBIC park every QcStatusChanged as an unknown transition.
        qc_status: qcStatusForBridge(graded),
      });

      return { qc };
    });
  }
}
