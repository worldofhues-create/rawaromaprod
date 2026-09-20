/**
 * ReservationService — soft allocations of finished-good stock (packaging.finished_good_reservation).
 * A reservation holds `reserved_qty` of an FG batch for a channel/document so it can't be
 * dispatched or promised twice; it counts against available-to-promise (computed by the fg-stock
 * BFF read-model) until released. createReservation records the hold (no availability guard here —
 * the reservation is a deliberate hold; over-dispatch is enforced at dispatch time where the
 * dispatched total is visible). releaseReservation stamps released_dt + status RELEASED.
 *
 * Pre-generated ids use uuidv7(); numerics stringified at insert (num); created_by/updated_by =
 * principal.userId; batch/sku/document/uom are the Data-Dictionary refs.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PACKAGING_DB, packagingSchema, type PackagingDb } from '../packaging.tokens.js';
import { num, paginate, type Page } from '../_helpers.js';
import type { CreateFinishedGoodReservation, ListQuery } from '../packaging.dtos.js';

const { finishedGoodReservation } = packagingSchema;

@Injectable()
export class ReservationService {
  constructor(@Inject(PACKAGING_DB) private readonly db: PackagingDb) {}

  /** POST /v1/fg-reservations — record a hold on an FG batch (defaults channel GENERAL, status ACTIVE). */
  async createReservation(body: CreateFinishedGoodReservation, principal: AuthPrincipal) {
    const row = (
      await this.db
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
    return row;
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
