/**
 * BatchService — the finished-good batch document + its child rows: FINISHED_GOOD_BATCH_MASTER,
 * FINISHED_GOODS_BATCH_CONSUMPTION. CRUD for both, plus the produce FLOW:
 *
 *   produceFinishedGoodBatch → insert a FINISHED_GOOD_BATCH_MASTER row (status ACTIVE) and any
 *                              finished_goods_batch_consumption lines, then — in the SAME
 *                              transaction — record `packaging.fg_batch.created`. Published iff
 *                              the batch + consumption committed.
 *
 * PROM-4 (LD-85, "Every pack carries a lot number tied to its batch record"): the lot is minted HERE,
 * at fill, from the sequence `packaging.fg_lot_seq` as FG-<yymm>-<nnnnn>, and a batchNumber in the
 * body is refused ("The lot is assigned at fill"). Never Math.random, never typed: the number on the
 * pack is the number on the record because there is only one place it is made.
 *
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; numerics are
 * stringified at insert (num); ISO timestamps → Date; manufacturing/expiry are plain date
 * strings (stored as-is). package_order / product_sku / consumed_for_document / uom are
 * dict-soft refs (plain uuid, no FK at this layer).
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
import { lotRuleInForce, recordOutbox, FILL_LOT_SERVER_ASSIGNED, type AuthPrincipal, type BridgeEmitTx } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PACKAGING_DB, packagingSchema, type PackagingDb } from '../packaging.tokens.js';
import { packagingEvents } from '../packaging.events.js';
import { num, paginate, type Page } from '../_helpers.js';
import type {
  CreateBatchConsumption,
  ListQuery,
  ProduceFinishedGoodBatch,
} from '../packaging.dtos.js';

const { finishedGoodBatchMaster, finishedGoodsBatchConsumption, outbox, packageOrder } = packagingSchema;

/** Package-order states in which finished goods can actually exist (lane/j2): filling has
 *  started (IN_PROGRESS) or finished (COMPLETED). */
const FG_PRODUCIBLE_ORDER_STATES = new Set(['IN_PROGRESS', 'COMPLETED']);

/** PROM-4: the finished-good lot, FG-<yymm>-<nnnnn>, from a database sequence (gaps allowed, never
 *  a repeat). The month is the fill's; the number alone is unique. */
export async function mintFgLot(tx: BridgeEmitTx, at: Date): Promise<string> {
  const rows = Array.from((await tx.execute(sql`select nextval('packaging.fg_lot_seq')::text as n`)) as unknown as { n: string }[]);
  const n = rows[0]?.n;
  if (!n) throw new Error('packaging.fg_lot_seq returned no value');
  const yymm = at.toISOString().slice(2, 7).replace('-', '');
  return `FG-${yymm}-${n.padStart(5, '0')}`;
}

@Injectable()
export class BatchService {
  constructor(@Inject(PACKAGING_DB) private readonly db: PackagingDb) {}

  /* ── flow: produce finished-good batch (+ consumption + outbox) ───── */

  /**
   * POST /v1/finished-good-batches — produce an FG batch, insert its consumption lines, and
   * emit `packaging.fg_batch.created`. All in one transaction.
   */
  async produceFinishedGoodBatch(body: ProduceFinishedGoodBatch, principal: AuthPrincipal) {
    if (body.batchNumber !== undefined && body.batchNumber !== null) {
      throw new BadRequestException(`The lot is assigned at fill: leave the lot number out and the server mints it (${FILL_LOT_SERVER_ASSIGNED}). A typed lot is never printed on a pack.`);
    }
    return this.db.transaction(async (tx) => {
      /* Golden journey lane/j2: an FG batch was accepted against a DRAFT package order —
       * no materials issued, no filling session, nothing filled — i.e. finished goods that
       * cannot physically exist. Require the order to be filling or filled. */
      const order = (
        await tx
          .select({ status: packageOrder.status })
          .from(packageOrder)
          .where(eq(packageOrder.packageOrderId, body.packageOrderId))
          .for('update')
          .limit(1)
      )[0];
      if (!order) throw new NotFoundException(`package_order not found: ${body.packageOrderId}`);
      const orderStatus = String(order.status ?? 'DRAFT').toUpperCase();
      if (!FG_PRODUCIBLE_ORDER_STATES.has(orderStatus)) {
        throw new ConflictException(
          `Cannot produce a finished-good batch on package order ${body.packageOrderId}: status is ${orderStatus} `
            + '(must be IN_PROGRESS or COMPLETED — issue materials and run a filling session first).',
        );
      }
      /* STOCK-E2E-1 (STK-4): finished stock is this batch's producedQty, so it may not exceed what the
       * order's filling sessions recorded as filled (rejected units are not finished goods), across every
       * batch already made on the order. Rehearsal: 14 units filled, a batch of 59 accepted, 45 units of
       * stock that were never filled. Compared only in the same unit; a fill recorded in another unit
       * cannot be checked here and is left to the batch-close reconciliation (WO-STK-RECON). */
      const [fill] = (await tx.execute(sql`
        select coalesce(sum(d.filled_qty), 0)::text as filled, count(*)::int as n,
               count(*) filter (where d.uom_id is distinct from ${body.uomId ?? null}::uuid)::int as other_unit,
               (select coalesce(sum(f.produced_qty), 0)::text from packaging.finished_good_batch_master f
                 where f.package_order_id = ${body.packageOrderId}::uuid and coalesce(f.status, '') not in ('REJECTED', 'CANCELLED')) as made
          from packaging.filling_session s join packaging.filling_session_details d on d.filling_session_id = s.filling_session_id
         where s.package_order_id = ${body.packageOrderId}::uuid`)) as unknown as Array<{ filled: string; n: number; other_unit: number; made: string }>;
      if (fill && fill.n > 0 && fill.other_unit === 0) {
        const filled = Number(fill.filled), made = Number(fill.made), asked = Number(body.producedQty);
        if (made + asked > filled) {
          throw new ConflictException(
            `Package order ${body.packageOrderId} filled ${filled}; ${made} already made into finished-goods batches, so a batch of ${asked} `
              + `would hold ${made + asked - filled} that were never filled. Record the fill first.`,
          );
        }
      }
      const rule = await lotRuleInForce(tx as unknown as BridgeEmitTx);
      const batchNumber = await mintFgLot(tx as unknown as BridgeEmitTx, new Date());
      const batchId = uuidv7();
      const batch = (
        await tx
          .insert(finishedGoodBatchMaster)
          .values({
            finishedGoodBatchId: batchId,
            packageOrderId: body.packageOrderId,
            productSkuId: body.productSkuId,
            batchNumber,
            lotAssignedAtFill: true,
            lotRuleVersion: rule.version,
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
          batchNumber,
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
