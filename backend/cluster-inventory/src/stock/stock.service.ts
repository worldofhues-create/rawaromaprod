/**
 * StockService — stock operations + expiry: CRUD over STOCK_ADJUSTMENT, STOCK_AUDIT,
 * STOCK_AUDIT_DETAILS, STOCK_RESERVATION, STOCK_TRANSFER and EXPIRY_TRACKER.
 * createStockAudit writes the audit header + its detail lines in one transaction. numeric →
 * String(n); timestamps → Date; date columns kept as ISO strings.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import {
  INVENTORY_DB,
  inventorySchema,
  type InventoryDb,
} from '../cluster-inventory.tokens.js';
import type { Page, ListQuery } from '../cluster-inventory.dtos.js';
import type {
  CreateExpiryTracker,
  CreateStockAdjustment,
  CreateStockAudit,
  CreateStockAuditDetail,
  CreateStockReservation,
  CreateStockTransfer,
} from '../cluster-inventory.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const {
  stockAdjustment,
  stockAudit,
  stockAuditDetails,
  stockReservation,
  stockTransfer,
  expiryTracker,
  inventoryBatch,
} = inventorySchema;

@Injectable()
export class StockService {
  constructor(@Inject(INVENTORY_DB) private readonly db: InventoryDb) {}

  /* ── stock_adjustment ───────────────────────────────────────────────── */

  async createStockAdjustment(body: CreateStockAdjustment, principal: AuthPrincipal) {
    // Ledger→balance: the adjustment qty (signed) is applied to the batch on-hand in the same
    // transaction, so a physical-count correction actually moves the stock figure.
    return this.db.transaction(async (tx) => {
      const adj = ensure(
        (
          await tx
            .insert(stockAdjustment)
            .values({
              inventoryBatchId: body.inventoryBatchId ?? null,
              adjustmentQty: body.adjustmentQty != null ? String(body.adjustmentQty) : null,
              uomId: body.uomId ?? null,
              adjustmentReason: body.adjustmentReason ?? null,
              adjustmentDt: body.adjustmentDt ? new Date(body.adjustmentDt) : new Date(),
              approvedBy: body.approvedBy ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );
      if (body.inventoryBatchId && body.adjustmentQty != null) {
        // Over-issue guard (audit #5): a correction must not take physical on-hand negative.
        const cur = (
          await tx.select({ onHand: inventoryBatch.quantityOnHand }).from(inventoryBatch).where(eq(inventoryBatch.inventoryBatchId, body.inventoryBatchId)).limit(1)
        )[0];
        if (Number(cur?.onHand ?? 0) + Number(body.adjustmentQty) < 0) {
          throw new ConflictException(`Adjustment would take on-hand negative (${Number(cur?.onHand ?? 0) + Number(body.adjustmentQty)}).`);
        }
        await tx
          .update(inventoryBatch)
          .set({
            quantityOnHand: sql`coalesce(${inventoryBatch.quantityOnHand}, 0) + ${Number(body.adjustmentQty)}`,
            updatedBy: principal.userId,
          })
          .where(eq(inventoryBatch.inventoryBatchId, body.inventoryBatchId));
      }
      return adj;
    });
  }

  async listStockAdjustments(
    query: ListQuery,
  ): Promise<Page<typeof stockAdjustment.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(stockAdjustment)
      .where(query.cursor ? lt(stockAdjustment.stockAdjustmentId, query.cursor) : undefined)
      .orderBy(desc(stockAdjustment.stockAdjustmentId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.stockAdjustmentId);
  }

  async getStockAdjustment(id: string) {
    return (
      (
        await this.db
          .select()
          .from(stockAdjustment)
          .where(eq(stockAdjustment.stockAdjustmentId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── FLOW: stock_audit (+ details) create ───────────────────────────── */

  async createStockAudit(body: CreateStockAudit, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const stockAuditId = uuidv7();
      const audit = ensure(
        (
          await tx
            .insert(stockAudit)
            .values({
              stockAuditId,
              auditCode: body.auditCode ?? null,
              auditType: body.auditType ?? null,
              locationId: body.locationId ?? null,
              auditStartDt: body.auditStartDt ? new Date(body.auditStartDt) : null,
              auditEndDt: body.auditEndDt ? new Date(body.auditEndDt) : null,
              initiatedBy: body.initiatedBy ?? principal.userId,
              approvedBy: body.approvedBy ?? null,
              approvedDt: body.approvedDt ? new Date(body.approvedDt) : null,
              remarks: body.remarks ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      const details: (typeof stockAuditDetails.$inferSelect)[] = [];
      for (const d of body.details) {
        const row = ensure(
          (
            await tx
              .insert(stockAuditDetails)
              .values({
                stockAuditDetailId: uuidv7(),
                stockAuditId,
                materialId: d.materialId ?? null,
                inventoryBatchId: d.inventoryBatchId ?? null,
                storageLocationId: d.storageLocationId ?? null,
                systemQty: d.systemQty != null ? String(d.systemQty) : null,
                countedQty: d.countedQty != null ? String(d.countedQty) : null,
                varianceQty: d.varianceQty != null ? String(d.varianceQty) : null,
                uomId: d.uomId ?? null,
                countedBy: d.countedBy ?? null,
                countedDt: d.countedDt ? new Date(d.countedDt) : null,
                varianceReason: d.varianceReason ?? null,
                status: 'ACTIVE',
                createdBy: principal.userId,
                updatedBy: principal.userId,
              })
              .returning()
          )[0],
        );
        details.push(row);
      }

      return { stockAudit: audit, details };
    });
  }

  async listStockAudits(query: ListQuery): Promise<Page<typeof stockAudit.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(stockAudit)
      .where(query.cursor ? lt(stockAudit.stockAuditId, query.cursor) : undefined)
      .orderBy(desc(stockAudit.stockAuditId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.stockAuditId);
  }

  async getStockAudit(id: string) {
    return (
      (
        await this.db
          .select()
          .from(stockAudit)
          .where(eq(stockAudit.stockAuditId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── stock_audit_details ────────────────────────────────────────────── */

  async createStockAuditDetail(body: CreateStockAuditDetail, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(stockAuditDetails)
          .values({
            stockAuditId: body.stockAuditId ?? null,
            materialId: body.materialId ?? null,
            inventoryBatchId: body.inventoryBatchId ?? null,
            storageLocationId: body.storageLocationId ?? null,
            systemQty: body.systemQty != null ? String(body.systemQty) : null,
            countedQty: body.countedQty != null ? String(body.countedQty) : null,
            varianceQty: body.varianceQty != null ? String(body.varianceQty) : null,
            uomId: body.uomId ?? null,
            countedBy: body.countedBy ?? null,
            countedDt: body.countedDt ? new Date(body.countedDt) : null,
            varianceReason: body.varianceReason ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listStockAuditDetails(
    query: ListQuery,
  ): Promise<Page<typeof stockAuditDetails.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(stockAuditDetails)
      .where(
        query.cursor ? lt(stockAuditDetails.stockAuditDetailId, query.cursor) : undefined,
      )
      .orderBy(desc(stockAuditDetails.stockAuditDetailId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.stockAuditDetailId);
  }

  async getStockAuditDetail(id: string) {
    return (
      (
        await this.db
          .select()
          .from(stockAuditDetails)
          .where(eq(stockAuditDetails.stockAuditDetailId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── stock_reservation ──────────────────────────────────────────────── */

  async createStockReservation(body: CreateStockReservation, principal: AuthPrincipal) {
    // Over-reserve guard (audit #5, RP-FAC2: made concurrency-safe — same check-then-insert race
    // that RP-FG-001's FG reservation had: the old code SELECTed on-hand + active reservations on
    // the base connection with no lock, then INSERTed; two concurrent requests against the same
    // batch could both read the same "available" figure and both pass, over-reserving the batch.
    // Now the whole check-then-insert runs inside one transaction that takes SELECT ... FOR UPDATE
    // on the inventory_batch row first, so a second concurrent reservation blocks until the first
    // commits/rolls back and always re-reads the post-commit reserved total.
    if (body.inventoryBatchId && body.reservedQty != null) {
      const inventoryBatchId = body.inventoryBatchId;
      if (!(Number(body.reservedQty) > 0)) throw new ConflictException('Reserved quantity must be positive.');
      return this.db.transaction(async (tx) => {
        const locked = (await tx.execute(sql`
          select quantity_on_hand, rm_batch_id from inventory.inventory_batch
           where inventory_batch_id = ${inventoryBatchId}
           for update`)) as unknown as Array<{ quantity_on_hand: string | null; rm_batch_id: string | null }>;
        const batch = locked[0];
        if (!batch) throw new NotFoundException(`inventory_batch not found: ${inventoryBatchId}`);

        // RP-FAC2 (RP-QC-002 follow-up): a batch QC dispositioned REJECT/HOLD/REWORK has zero
        // eligible stock — the disposition drives reservation eligibility automatically, matching
        // the same block the inventory-availability read-model already applies.
        let qcBlocked = false;
        if (batch.rm_batch_id) {
          const qc = (await tx.execute(sql`
            select overall_result from quality.qc_inspections
             where rm_batch_id = ${batch.rm_batch_id}
             order by created_dt desc limit 1`)) as unknown as Array<{ overall_result: string | null }>;
          qcBlocked = ['REJECT', 'HOLD', 'REWORK'].includes(String(qc[0]?.overall_result ?? '').toUpperCase());
        }

        const reserved = (
          await tx
            .select({ total: sql<string>`coalesce(sum(${stockReservation.reservedQty}), 0)::text` })
            .from(stockReservation)
            .where(and(eq(stockReservation.inventoryBatchId, inventoryBatchId), isNull(stockReservation.releasedDt)))
        )[0];
        const available = qcBlocked ? 0 : Number(batch.quantity_on_hand ?? 0) - Number(reserved?.total ?? 0);
        if (Number(body.reservedQty) > available) {
          throw new ConflictException(`Cannot reserve ${body.reservedQty}: only ${available} available on this batch (on-hand − active reservations${qcBlocked ? '; batch is QC REJECT/HOLD/REWORK' : ''}).`);
        }

        return ensure(
          (
            await tx
              .insert(stockReservation)
              .values({
                inventoryBatchId: body.inventoryBatchId ?? null,
                reservedQty: body.reservedQty != null ? String(body.reservedQty) : null,
                uomId: body.uomId ?? null,
                reservedForDocumentId: body.reservedForDocumentId ?? null,
                reservedDt: body.reservedDt ? new Date(body.reservedDt) : new Date(),
                releasedDt: body.releasedDt ? new Date(body.releasedDt) : null,
                status: 'ACTIVE',
                createdBy: principal.userId,
                updatedBy: principal.userId,
              })
              .returning()
          )[0],
        );
      });
    }
    return ensure(
      (
        await this.db
          .insert(stockReservation)
          .values({
            inventoryBatchId: body.inventoryBatchId ?? null,
            reservedQty: body.reservedQty != null ? String(body.reservedQty) : null,
            uomId: body.uomId ?? null,
            reservedForDocumentId: body.reservedForDocumentId ?? null,
            reservedDt: body.reservedDt ? new Date(body.reservedDt) : new Date(),
            releasedDt: body.releasedDt ? new Date(body.releasedDt) : null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  /**
   * POST /v1/stock-reservations/:id/release — RP-FAC2: the only way to release an RM reservation
   * used to be the generic EditService bypass, PATCHing `status`/`reserved_qty` directly with no
   * guard at all (could "release" an already-released row, or silently change the reserved qty in
   * place instead of freeing it). Now a real guarded transition: CAS ACTIVE→RELEASED under a row
   * lock, mirroring the FG reservation release.
   */
  async releaseStockReservation(id: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        select stock_reservation_id, status, released_dt from inventory.stock_reservation
         where stock_reservation_id = ${id}
         for update`)) as unknown as Array<{ stock_reservation_id: string; status: string | null; released_dt: Date | null }>;
      const row = locked[0];
      if (!row) throw new NotFoundException(`stock_reservation not found: ${id}`);
      if (row.released_dt || String(row.status ?? '').toUpperCase() === 'RELEASED') {
        throw new ConflictException(`Stock reservation ${id} is already released.`);
      }
      return ensure(
        (
          await tx
            .update(stockReservation)
            .set({ releasedDt: new Date(), status: 'RELEASED', updatedBy: principal.userId })
            .where(and(eq(stockReservation.stockReservationId, id), isNull(stockReservation.releasedDt)))
            .returning()
        )[0],
      );
    });
  }

  async listStockReservations(
    query: ListQuery,
  ): Promise<Page<typeof stockReservation.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(stockReservation)
      .where(
        query.cursor ? lt(stockReservation.stockReservationId, query.cursor) : undefined,
      )
      .orderBy(desc(stockReservation.stockReservationId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.stockReservationId);
  }

  async getStockReservation(id: string) {
    return (
      (
        await this.db
          .select()
          .from(stockReservation)
          .where(eq(stockReservation.stockReservationId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── stock_transfer ─────────────────────────────────────────────────── */

  async createStockTransfer(body: CreateStockTransfer, principal: AuthPrincipal) {
    // Apply the move (audit H-C1): a transfer used to only record a row; the batch never moved.
    // Now the batch physically relocates to the destination in the same transaction. (Single-
    // location batch model: the whole batch moves — a partial-quantity split into two batches is
    // not modelled, so a partial transfer still relocates the batch record.)
    return this.db.transaction(async (tx) => {
      const row = ensure(
        (
          await tx
            .insert(stockTransfer)
            .values({
              inventoryBatchId: body.inventoryBatchId ?? null,
              fromLocationId: body.fromLocationId ?? null,
              toLocationId: body.toLocationId ?? null,
              transferQty: body.transferQty != null ? String(body.transferQty) : null,
              uomId: body.uomId ?? null,
              transferDt: body.transferDt ? new Date(body.transferDt) : new Date(),
              requestedBy: body.requestedBy ?? principal.userId,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );
      if (body.inventoryBatchId && body.toLocationId) {
        await tx
          .update(inventoryBatch)
          .set({ storageLocationId: body.toLocationId, updatedBy: principal.userId })
          .where(eq(inventoryBatch.inventoryBatchId, body.inventoryBatchId));
      }
      return row;
    });
  }

  async listStockTransfers(
    query: ListQuery,
  ): Promise<Page<typeof stockTransfer.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(stockTransfer)
      .where(query.cursor ? lt(stockTransfer.stockTransferId, query.cursor) : undefined)
      .orderBy(desc(stockTransfer.stockTransferId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.stockTransferId);
  }

  async getStockTransfer(id: string) {
    return (
      (
        await this.db
          .select()
          .from(stockTransfer)
          .where(eq(stockTransfer.stockTransferId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── expiry_tracker ─────────────────────────────────────────────────── */

  async createExpiryTracker(body: CreateExpiryTracker, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(expiryTracker)
          .values({
            batchType: body.batchType,
            rmBatchId: body.rmBatchId ?? null,
            oilBatchId: body.oilBatchId ?? null,
            finishedGoodBatchId: body.finishedGoodBatchId ?? null,
            materialId: body.materialId ?? null,
            manufacturingDate: body.manufacturingDate ?? null,
            expiryDate: body.expiryDate ?? null,
            remainingDays: body.remainingDays ?? null,
            alertThresholdDays: body.alertThresholdDays ?? null,
            alertSentDt: body.alertSentDt ? new Date(body.alertSentDt) : null,
            alertSentTo: body.alertSentTo ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listExpiryTrackers(
    query: ListQuery,
  ): Promise<Page<typeof expiryTracker.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(expiryTracker)
      .where(query.cursor ? lt(expiryTracker.expiryTrackerId, query.cursor) : undefined)
      .orderBy(desc(expiryTracker.expiryTrackerId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.expiryTrackerId);
  }

  async getExpiryTracker(id: string) {
    return (
      (
        await this.db
          .select()
          .from(expiryTracker)
          .where(eq(expiryTracker.expiryTrackerId, id))
          .limit(1)
      )[0] ?? null
    );
  }
}
