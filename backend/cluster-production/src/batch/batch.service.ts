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
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { productionEvents } from '../production.events.js';
import { paginate, num, type Page } from '../_helpers.js';
import type { ListQuery, ProduceOilBatch, RecordProductionQc } from '../production.dtos.js';

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
    return this.db.transaction(async (tx) => {
      const qc = (
        await tx
          .insert(productionQc)
          .values({
            productionQcId: uuidv7(),
            oilBatchId: body.oilBatchId,
            qcParameterId: body.qcParameterId ?? null,
            observedValue: num(body.observedValue),
            result: body.result ?? null,
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
        { productionQcId, oilBatchId: body.oilBatchId, result: body.result ?? null },
        productionQcId,
      );

      return { qc };
    });
  }
}
