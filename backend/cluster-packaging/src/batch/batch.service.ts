/**
 * BatchService — the finished-good batch document + its child rows: FINISHED_GOOD_BATCH_MASTER,
 * FINISHED_GOODS_BATCH_CONSUMPTION. CRUD for both, plus the produce FLOW:
 *
 *   produceFinishedGoodBatch → insert a FINISHED_GOOD_BATCH_MASTER row (status ACTIVE) and any
 *                              finished_goods_batch_consumption lines, then — in the SAME
 *                              transaction — record `packaging.fg_batch.created`. Published iff
 *                              the batch + consumption committed.
 *
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; numerics are
 * stringified at insert (num); ISO timestamps → Date; manufacturing/expiry are plain date
 * strings (stored as-is). package_order / product_sku / consumed_for_document / uom are
 * dict-soft refs (plain uuid, no FK at this layer).
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PACKAGING_DB, packagingSchema, type PackagingDb } from '../packaging.tokens.js';
import { packagingEvents } from '../packaging.events.js';
import { num, paginate, type Page } from '../_helpers.js';
import type {
  CreateBatchConsumption,
  ListQuery,
  ProduceFinishedGoodBatch,
} from '../packaging.dtos.js';

const { finishedGoodBatchMaster, finishedGoodsBatchConsumption, outbox } = packagingSchema;

@Injectable()
export class BatchService {
  constructor(@Inject(PACKAGING_DB) private readonly db: PackagingDb) {}

  /* ── flow: produce finished-good batch (+ consumption + outbox) ───── */

  /**
   * POST /v1/finished-good-batches — produce an FG batch, insert its consumption lines, and
   * emit `packaging.fg_batch.created`. All in one transaction.
   */
  async produceFinishedGoodBatch(body: ProduceFinishedGoodBatch, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const batchId = uuidv7();
      const batch = (
        await tx
          .insert(finishedGoodBatchMaster)
          .values({
            finishedGoodBatchId: batchId,
            packageOrderId: body.packageOrderId,
            productSkuId: body.productSkuId,
            batchNumber: body.batchNumber,
            producedQty: num(body.producedQty),
            uomId: body.uomId ?? null,
            manufacturingDate: body.manufacturingDate ?? null,
            expiryDate: body.expiryDate ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!batch) throw new Error('insert failed: finished_good_batch_master');

      let consumption: (typeof finishedGoodsBatchConsumption.$inferSelect)[] = [];
      if (body.consumption && body.consumption.length > 0) {
        consumption = await tx
          .insert(finishedGoodsBatchConsumption)
          .values(
            body.consumption.map((c) => ({
              finishedGoodsBatchConsumptionId: uuidv7(),
              finishedGoodBatchId: batchId,
              consumedForDocumentId: c.consumedForDocumentId ?? null,
              consumedQty: num(c.consumedQty),
              uomId: c.uomId ?? null,
              consumedDt: new Date(),
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })),
          )
          .returning();
      }

      await recordOutbox(
        tx,
        outbox,
        packagingEvents.fgBatchCreated,
        {
          finishedGoodBatchId: batchId,
          packageOrderId: body.packageOrderId,
          batchNumber: body.batchNumber,
        },
        batchId,
      );

      // NO FgBatchAvailable here (golden journey lane/j2). A just-produced FG batch has not
      // been through packaging QC; emitting availability at this point told ALEMBIC the goods
      // were FG_READY before QC had looked at them (live: two FgBatchAvailable per batch, the
      // first premature). The G3 PackagingReleaseService emits FgBatchAvailable on packaging
      // QC PASS — backend/api/src/automation/packaging-release.service.ts — the one correct
      // moment ("packaging QC pass → FG release → ATP → emit availability", directive §18).

      return { batch, consumption };
    });
  }

  async listFinishedGoodBatches(
    query: ListQuery,
  ): Promise<Page<typeof finishedGoodBatchMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(finishedGoodBatchMaster)
      .where(
        query.cursor ? lt(finishedGoodBatchMaster.finishedGoodBatchId, query.cursor) : undefined,
      )
      .orderBy(desc(finishedGoodBatchMaster.finishedGoodBatchId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.finishedGoodBatchId);
  }

  async getFinishedGoodBatch(id: string) {
    return (
      await this.db
        .select()
        .from(finishedGoodBatchMaster)
        .where(eq(finishedGoodBatchMaster.finishedGoodBatchId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── finished-goods batch consumption (CRUD) ──────────────────────── */

  async createBatchConsumption(body: CreateBatchConsumption, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(finishedGoodsBatchConsumption)
        .values({
          finishedGoodsBatchConsumptionId: uuidv7(),
          finishedGoodBatchId: body.finishedGoodBatchId,
          consumedForDocumentId: body.consumedForDocumentId ?? null,
          consumedQty: num(body.consumedQty),
          uomId: body.uomId ?? null,
          consumedDt: body.consumedDt ? new Date(body.consumedDt) : new Date(),
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: finished_goods_batch_consumption');
    return row;
  }

  async listBatchConsumption(
    query: ListQuery,
  ): Promise<Page<typeof finishedGoodsBatchConsumption.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(finishedGoodsBatchConsumption)
      .where(
        query.cursor
          ? lt(finishedGoodsBatchConsumption.finishedGoodsBatchConsumptionId, query.cursor)
          : undefined,
      )
      .orderBy(desc(finishedGoodsBatchConsumption.finishedGoodsBatchConsumptionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.finishedGoodsBatchConsumptionId);
  }

  async getBatchConsumption(id: string) {
    return (
      await this.db
        .select()
        .from(finishedGoodsBatchConsumption)
        .where(eq(finishedGoodsBatchConsumption.finishedGoodsBatchConsumptionId, id))
        .limit(1)
    )[0] ?? null;
  }
}
