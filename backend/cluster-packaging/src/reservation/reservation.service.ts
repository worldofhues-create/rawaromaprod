/**
 * ReservationService — soft allocations of finished-good stock (packaging.finished_good_reservation).
 * A reservation holds `reserved_qty` of an FG batch for a channel/document so it can't be
 * dispatched or promised twice; it counts against available-to-promise (computed by the fg-stock
 * BFF read-model) until released. createReservation now (RP-FAC: RP-FG-001/RP-INV-004 follow-up)
 * re-derives the SAME available formula the fg-stock read-model and DispatchService use —
 * produced − dispatched − consumed − reserved, zero if packaging QC FAILed — inside one
 * transaction that takes `SELECT ... FOR UPDATE` on the FG batch row first, so two concurrent
 * reservation requests against the same batch serialize instead of both reading a stale
 * "available" figure and both succeeding (the previous version had NO guard at all: any reserved_qty
 * was accepted unconditionally). releaseReservation stamps released_dt + status RELEASED.
 *
 * Pre-generated ids use uuidv7(); numerics stringified at insert (num); created_by/updated_by =
 * principal.userId; batch/sku/document/uom are the Data-Dictionary refs.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
import { emitBridgeOutbound, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PACKAGING_DB, packagingSchema, type PackagingDb } from '../packaging.tokens.js';
import { num, paginate, type Page } from '../_helpers.js';
import type { CreateFinishedGoodReservation, ListQuery } from '../packaging.dtos.js';

const { finishedGoodReservation } = packagingSchema;

@Injectable()
export class ReservationService {
  constructor(@Inject(PACKAGING_DB) private readonly db: PackagingDb) {}

  /**
   * POST /v1/fg-reservations — record a hold on an FG batch (defaults channel GENERAL, status
   * ACTIVE), guarded so reserved_qty can never push the batch's committed allocations past what
   * was actually produced.
   */
  async createReservation(body: CreateFinishedGoodReservation, principal: AuthPrincipal) {
    if (!(Number(body.reservedQty) > 0)) {
      throw new ConflictException(`Reserved quantity must be positive (got ${body.reservedQty}).`);
    }
    return this.db.transaction(async (tx) => {
      // Lock the FG batch row for the life of this tx: a concurrent reservation or dispatch on
      // the same batch blocks here until this tx commits/rolls back, so the "available" figure
      // computed below is never stale by the time we insert.
      const locked = (await tx.execute(sql`
        select produced_qty from packaging.finished_good_batch_master
         where finished_good_batch_id = ${body.finishedGoodBatchId}
         for update`)) as unknown as Array<{ produced_qty: string | null }>;
      const batch = locked[0];
      if (!batch) {
        throw new NotFoundException(`finished_good_batch not found: ${body.finishedGoodBatchId}`);
      }

      const dispatched = (await tx.execute(sql`
        select coalesce(sum(dispatched_qty), 0)::text as total from sales.dispatch_items
         where finished_good_batch_id = ${body.finishedGoodBatchId} and coalesce(status, 'ACTIVE') <> 'CANCELLED'`
      )) as unknown as Array<{ total: string }>;
      const consumed = (await tx.execute(sql`
        select coalesce(sum(consumed_qty), 0)::text as total from packaging.finished_goods_batch_consumption
         where finished_good_batch_id = ${body.finishedGoodBatchId} and coalesce(status, 'ACTIVE') <> 'CANCELLED'`
      )) as unknown as Array<{ total: string }>;
      const reserved = (await tx.execute(sql`
        select coalesce(sum(reserved_qty), 0)::text as total from packaging.finished_good_reservation
         where finished_good_batch_id = ${body.finishedGoodBatchId} and released_dt is null and coalesce(status, 'ACTIVE') <> 'RELEASED'`
      )) as unknown as Array<{ total: string }>;
      const qc = (await tx.execute(sql`
        select overall_result from packaging.packaging_qc
         where finished_good_batch_id = ${body.finishedGoodBatchId}
         order by created_dt desc limit 1`
      )) as unknown as Array<{ overall_result: string | null }>;
      // lane/j2: sellable only once packaging QC has PASSED — un-inspected or HOLD is not available
      // either (was: only an explicit FAIL blocked). Field name kept for its callers.
      const qcFailed = String(qc[0]?.overall_result ?? '').toUpperCase() !== 'PASS';

      const available = qcFailed
        ? 0
        : Number(batch.produced_qty ?? 0) -
          Number(dispatched[0]?.total ?? 0) -
          Number(consumed[0]?.total ?? 0) -
          Number(reserved[0]?.total ?? 0);

      if (Number(body.reservedQty) > available) {
        throw new ConflictException(
          `Cannot reserve ${body.reservedQty} of finished-good batch ${body.finishedGoodBatchId}: only ${available} available (produced − dispatched − consumed − reserved${qcFailed ? '; batch has not PASSED packaging QC' : ''}).`,
        );
      }

      const row = (
        await tx
          .insert(finishedGoodReservation)
          .values({
            finishedGoodReservationId: uuidv7(),
            finishedGoodBatchId: body.finishedGoodBatchId,
            productSkuId: body.productSkuId ?? null,
            reservedQty: num(body.reservedQty),
            channel: body.channel ?? 'GENERAL',
            reservedForDocumentId: body.reservedForDocumentId ?? null,
            reservedDt: new Date(),
            uomId: body.uomId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!row) throw new Error('insert failed: finished_good_reservation');

      // RP-EMIT (lane F6): resolve the production order two hops back (this FG batch's
      // package order's oil batch's production order), then emit AtpAllocationGranted
      // toward ALEMBIC iff that order fulfills a bridge requirement.
      const order = (await tx.execute(sql`
        select ob.production_order_id
          from packaging.finished_good_batch_master fg
          join packaging.package_order po on po.package_order_id = fg.package_order_id
          join production.oil_batch_master ob on ob.oil_batch_id = po.oil_batch_id
         where fg.finished_good_batch_id = ${body.finishedGoodBatchId}`
      )) as unknown as Array<{ production_order_id: string | null }>;
      await emitBridgeOutbound(tx, 'AtpAllocationGranted', order[0]?.production_order_id, {
        finished_good_reservation_id: row.finishedGoodReservationId,
        finished_good_batch_id: body.finishedGoodBatchId,
        reserved_qty: row.reservedQty,
      });

      return row;
    });
  }

  /** POST /v1/fg-reservations/:id/release — free the hold (released_dt + status RELEASED). */
  async releaseReservation(id: string, principal: AuthPrincipal) {
    const row = (
      await this.db
        .update(finishedGoodReservation)
        .set({ releasedDt: new Date(), status: 'RELEASED', updatedBy: principal.userId })
        .where(eq(finishedGoodReservation.finishedGoodReservationId, id))
        .returning()
    )[0];
    if (!row) throw new NotFoundException(`finished_good_reservation not found: ${id}`);
    return row;
  }

  async listReservations(
    query: ListQuery,
  ): Promise<Page<typeof finishedGoodReservation.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(finishedGoodReservation)
      .where(
        query.cursor
          ? lt(finishedGoodReservation.finishedGoodReservationId, query.cursor)
          : undefined,
      )
      .orderBy(desc(finishedGoodReservation.finishedGoodReservationId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.finishedGoodReservationId);
  }

  async getReservation(id: string) {
    return (
      await this.db
        .select()
        .from(finishedGoodReservation)
        .where(eq(finishedGoodReservation.finishedGoodReservationId, id))
        .limit(1)
    )[0] ?? null;
  }
}
