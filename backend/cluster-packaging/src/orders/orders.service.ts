/**
 * OrdersService — the package-order document + its child rows: PACKAGE_ORDER,
 * PACKAGE_ORDER_ITEM, FILLING_SESSION, FILLING_SESSION_DETAILS. CRUD for all four, plus the
 * order FLOWS:
 *
 *   createPackageOrder → insert a DRAFT package_order against a product_sku + oil_batch, then
 *                        (optionally) expand package_order_item rows from packaging_bom_master
 *                        rows matching the SKU (issued_qty defaults BOOLEAN false), and — in the
 *                        SAME transaction — record `packaging.order.created`.
 *   startFillingSession → open an ACTIVE filling_session against a package_order.
 *   endFillingSession   → stamp session_end_dt, flip status to DONE.
 *   recordFilling       → append a filling_session_details row (filled / rejected qty) and emit
 *                        the optional `packaging.filling.done` signal in one transaction.
 *
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; numerics are
 * stringified at insert (num); ISO timestamps → Date. package_order_item.issued_qty is a
 * BOOLEAN (dictionary-locked). sku / oil_batch / location / material / operator / uom are
 * cross-schema or dict-soft refs (plain uuid, no FK at this layer).
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PACKAGING_DB, packagingSchema, type PackagingDb } from '../packaging.tokens.js';
import { packagingEvents } from '../packaging.events.js';
import { num, paginate, type Page } from '../_helpers.js';
import type {
  CreateFillingSession,
  CreatePackageOrder,
  CreatePackageOrderItem,
  EndFillingSession,
  ListQuery,
  RecordFilling,
} from '../packaging.dtos.js';

const {
  packageOrder,
  packageOrderItem,
  packagingBomMaster,
  productSku,
  fillingSession,
  fillingSessionDetails,
  outbox,
} = packagingSchema;

// Package-order lifecycle (RP-FAC2 / RP-PKG-001, §33): the order used to sit permanently in
// DRAFT — no status ever advanced past creation, so "packaging materials issued", "filling in
// progress" and "completed" were never server-enforced facts, only whatever the UI happened to
// display. The only legal moves now:
const PACKAGE_ORDER_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['MATERIALS_ISSUED', 'CANCELLED'],
  MATERIALS_ISSUED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

@Injectable()
export class OrdersService {
  constructor(@Inject(PACKAGING_DB) private readonly db: PackagingDb) {}

  /* ── flow: create package order (+ BOM expansion + outbox) ────────── */

  /**
   * POST /v1/package-orders — open a DRAFT package order, optionally expand its item rows from
   * the SKU's packaging BOM, and emit `packaging.order.created`. All in one transaction so the
   * event is published iff the order + items committed.
   */
  async createPackageOrder(body: CreatePackageOrder, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      // Gate (§33 step 1, RP-FAC2): a package order can only be opened against oil that has
      // actually been RELEASED by the oil-batch state machine — not maturing, on hold, in
      // rework, or failed. Previously any oil_batch_id was accepted unchecked.
      const oil = (await tx.execute(sql`
        select status from production.oil_batch_master where oil_batch_id = ${body.oilBatchId}`
      )) as unknown as Array<{ status: string | null }>;
      if (!oil[0]) throw new NotFoundException(`oil_batch not found: ${body.oilBatchId}`);
      if (String(oil[0].status ?? '').toUpperCase() !== 'RELEASED') {
        throw new ConflictException(
          `Cannot open a package order against oil batch ${body.oilBatchId}: status is ${oil[0].status ?? '(none)'} (must be RELEASED).`,
        );
      }

      const orderId = uuidv7();
      const order = (
        await tx
          .insert(packageOrder)
          .values({
            packageOrderId: orderId,
            productSkuId: body.productSkuId,
            oilBatchId: body.oilBatchId,
            locationId: body.locationId ?? null,
            orderQty: num(body.orderQty),
            uomId: body.uomId ?? null,
            plannedStartDt: body.plannedStartDt ? new Date(body.plannedStartDt) : null,
            plannedEndDt: body.plannedEndDt ? new Date(body.plannedEndDt) : null,
            status: 'DRAFT',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!order) throw new Error('insert failed: package_order');

      // Expand package_order_item from the SKU's packaging BOM (soft-ref match, no FK).
      const bomRows = await tx
        .select()
        .from(packagingBomMaster)
        .where(eq(packagingBomMaster.productSkuId, body.productSkuId));

      let items: (typeof packageOrderItem.$inferSelect)[] = [];
      if (bomRows.length > 0) {
        items = await tx
          .insert(packageOrderItem)
          .values(
            bomRows.map((b) => ({
              packageOrderItemId: uuidv7(),
              packageOrderId: orderId,
              packagingMaterialId: b.packagingMaterialId ?? null,
              requiredQty: b.requiredQty ?? null,
              issuedQty: false,
              uomId: b.uomId ?? null,
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
        packagingEvents.orderCreated,
        { packageOrderId: orderId, oilBatchId: body.oilBatchId },
        orderId,
      );

      return { order, items };
    });
  }

  async listPackageOrders(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    const rows = await this.db
      .select()
      .from(packageOrder)
      .where(query.cursor ? lt(packageOrder.packageOrderId, query.cursor) : undefined)
      .orderBy(desc(packageOrder.packageOrderId))
      .limit(query.limit + 1);
    // Portal-audit WS4: attach the human-readable SKU code (the list showed a raw product_sku_id
    // uuid). Joined in JS to keep the fully-typed, camelCased base row intact for row actions.
    const skuIds = [...new Set(rows.map((r) => r.productSkuId).filter((v): v is string => !!v))];
    const skus = skuIds.length
      ? await this.db
          .select({ id: productSku.productSkuId, code: productSku.skuCode })
          .from(productSku)
          .where(inArray(productSku.productSkuId, skuIds))
      : [];
    const codeById = new Map(skus.map((s) => [s.id, s.code]));
    const enriched = rows.map((r) => ({
      ...r,
      skuCode: r.productSkuId ? codeById.get(r.productSkuId) ?? null : null,
    }));
    return paginate(enriched, query.limit, (r) => r.packageOrderId);
  }

  async getPackageOrder(id: string) {
    return (
      await this.db.select().from(packageOrder).where(eq(packageOrder.packageOrderId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── flow: issue packaging materials (DRAFT → MATERIALS_ISSUED) ──────── */

  /**
   * POST /v1/package-orders/:id/issue-materials — §33 step: BOM/material check + issue. Guarded
   * CAS DRAFT→MATERIALS_ISSUED under a row lock (so two concurrent issue calls on the same order
   * can't both win), and a real shortage check first: every package_order_item's required_qty is
   * compared against the packaging material's available stock (on-hand across all its inventory
   * batches, net of active reservations) before anything is flagged issued. Any shortfall rejects
   * the WHOLE issue (no partial issuance) and lists exactly what's short.
   */
  async issuePackagingMaterials(orderId: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        select status from packaging.package_order where package_order_id = ${orderId} for update`
      )) as unknown as Array<{ status: string | null }>;
      if (!locked[0]) throw new NotFoundException(`package_order not found: ${orderId}`);
      const current = String(locked[0].status ?? 'DRAFT').toUpperCase();
      if (!(PACKAGE_ORDER_TRANSITIONS[current] ?? []).includes('MATERIALS_ISSUED')) {
        throw new ConflictException(`Package order cannot issue materials from status ${current} (must be DRAFT).`);
      }

      const items = await tx.select().from(packageOrderItem).where(eq(packageOrderItem.packageOrderId, orderId));
      if (items.length === 0) {
        throw new ConflictException(`Package order ${orderId} has no BOM items to issue.`);
      }

      const shortages: string[] = [];
      for (const item of items) {
        if (!item.packagingMaterialId || item.requiredQty == null) continue;
        const avail = (await tx.execute(sql`
          select coalesce(sum(ib.quantity_on_hand), 0) - coalesce((
            select sum(sr.reserved_qty) from inventory.stock_reservation sr
            join inventory.inventory_batch ib2 on ib2.inventory_batch_id = sr.inventory_batch_id
            where ib2.material_id = ${item.packagingMaterialId} and sr.released_dt is null
          ), 0) as available
          from inventory.inventory_batch ib
          where ib.material_id = ${item.packagingMaterialId}`
        )) as unknown as Array<{ available: string | null }>;
        const available = Number(avail[0]?.available ?? 0);
        if (Number(item.requiredQty) > available) {
          shortages.push(`material ${item.packagingMaterialId}: required ${item.requiredQty}, available ${available}`);
        }
      }
      if (shortages.length > 0) {
        throw new ConflictException(`Cannot issue packaging materials — shortage(s): ${shortages.join('; ')}`);
      }

      await tx
        .update(packageOrderItem)
        .set({ issuedQty: true, updatedBy: principal.userId })
        .where(eq(packageOrderItem.packageOrderId, orderId));

      const updated = (
        await tx
          .update(packageOrder)
          .set({ status: 'MATERIALS_ISSUED', updatedBy: principal.userId })
          .where(and(eq(packageOrder.packageOrderId, orderId), eq(packageOrder.status, current)))
          .returning()
      )[0];
      if (!updated) {
        throw new ConflictException(`Package order ${orderId} was moved off ${current} by a concurrent request; refusing this stale issue.`);
      }
      return { order: updated, itemsIssued: items.length };
    });
  }

  /* ── flow: cancel (any non-terminal state) ────────────────────────── */

  /**
   * POST /v1/package-orders/:id/cancel — guarded CAS to CANCELLED from any non-terminal state. If
   * materials had already been flagged issued, the issued_qty flag is reversed (this dictionary
   * table has no inventory_batch linkage on package_order_item — issued_qty is a locked BOOLEAN —
   * so no batch-level quantity was ever decremented at issue time to reverse; the flag reversal is
   * the full correction available at this layer).
   */
  async cancelPackageOrder(orderId: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        select status from packaging.package_order where package_order_id = ${orderId} for update`
      )) as unknown as Array<{ status: string | null }>;
      if (!locked[0]) throw new NotFoundException(`package_order not found: ${orderId}`);
      const current = String(locked[0].status ?? 'DRAFT').toUpperCase();
      if (!(PACKAGE_ORDER_TRANSITIONS[current] ?? []).includes('CANCELLED')) {
        throw new ConflictException(`Package order cannot be cancelled from status ${current}.`);
      }

      if (current === 'MATERIALS_ISSUED' || current === 'IN_PROGRESS') {
        await tx
          .update(packageOrderItem)
          .set({ issuedQty: false, updatedBy: principal.userId })
          .where(eq(packageOrderItem.packageOrderId, orderId));
      }

      const updated = (
        await tx
          .update(packageOrder)
          .set({ status: 'CANCELLED', updatedBy: principal.userId })
          .where(and(eq(packageOrder.packageOrderId, orderId), eq(packageOrder.status, current)))
          .returning()
      )[0];
      if (!updated) {
        throw new ConflictException(`Package order ${orderId} was moved off ${current} by a concurrent request; refusing this stale cancel.`);
      }
      return updated;
    });
  }

  /* ── flow: complete (IN_PROGRESS → COMPLETED, yield/reject roll-up) ──── */

  /**
   * POST /v1/package-orders/:id/complete — guarded CAS IN_PROGRESS→COMPLETED. Refuses while any
   * filling_session on this order is still ACTIVE (no completing an order mid-fill). Rolls up
   * yield/reject qty across every filling_session_details row on the order's sessions.
   */
  async completePackageOrder(orderId: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        select status from packaging.package_order where package_order_id = ${orderId} for update`
      )) as unknown as Array<{ status: string | null }>;
      if (!locked[0]) throw new NotFoundException(`package_order not found: ${orderId}`);
      const current = String(locked[0].status ?? 'DRAFT').toUpperCase();
      if (!(PACKAGE_ORDER_TRANSITIONS[current] ?? []).includes('COMPLETED')) {
        throw new ConflictException(`Package order cannot be completed from status ${current} (must be IN_PROGRESS).`);
      }

      const openSessions = (await tx.execute(sql`
        select count(*)::int as n from packaging.filling_session
         where package_order_id = ${orderId} and coalesce(status, 'ACTIVE') = 'ACTIVE'`
      )) as unknown as Array<{ n: number }>;
      if ((openSessions[0]?.n ?? 0) > 0) {
        throw new ConflictException(`Package order ${orderId} still has an ACTIVE filling session — end it before completing the order.`);
      }

      const totals = (await tx.execute(sql`
        select coalesce(sum(fsd.filled_qty), 0)::float as filled, coalesce(sum(fsd.rejected_qty), 0)::float as rejected
          from packaging.filling_session_details fsd
          join packaging.filling_session fs on fs.filling_session_id = fsd.filling_session_id
         where fs.package_order_id = ${orderId}`
      )) as unknown as Array<{ filled: number; rejected: number }>;

      const updated = (
        await tx
          .update(packageOrder)
          .set({ status: 'COMPLETED', updatedBy: principal.userId })
          .where(and(eq(packageOrder.packageOrderId, orderId), eq(packageOrder.status, current)))
          .returning()
      )[0];
      if (!updated) {
        throw new ConflictException(`Package order ${orderId} was moved off ${current} by a concurrent request; refusing this stale completion.`);
      }
      return { order: updated, filledQty: totals[0]?.filled ?? 0, rejectedQty: totals[0]?.rejected ?? 0 };
    });
  }

  /* ── package order item (CRUD) ────────────────────────────────────── */

  async createPackageOrderItem(body: CreatePackageOrderItem, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(packageOrderItem)
        .values({
          packageOrderItemId: uuidv7(),
          packageOrderId: body.packageOrderId,
          packagingMaterialId: body.packagingMaterialId ?? null,
          requiredQty: num(body.requiredQty),
          issuedQty: body.issuedQty ?? false,
          uomId: body.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: package_order_item');
    return row;
  }

  async listPackageOrderItems(
    query: ListQuery,
  ): Promise<Page<typeof packageOrderItem.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(packageOrderItem)
      .where(query.cursor ? lt(packageOrderItem.packageOrderItemId, query.cursor) : undefined)
      .orderBy(desc(packageOrderItem.packageOrderItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.packageOrderItemId);
  }

  async getPackageOrderItem(id: string) {
    return (
      await this.db
        .select()
        .from(packageOrderItem)
        .where(eq(packageOrderItem.packageOrderItemId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── flow: filling session start / end ────────────────────────────── */

  /**
   * POST /v1/filling-sessions — open an ACTIVE filling session against a package order. RP-FAC2:
   * guarded — the order must have had its packaging materials issued (MATERIALS_ISSUED or already
   * IN_PROGRESS), and only ONE filling session may be ACTIVE per order at a time (single-writer
   * guard, same shape as RP-DISP-002's dispatch guard) — two operators can't fill the same order
   * concurrently. The first session opened auto-advances the order MATERIALS_ISSUED→IN_PROGRESS
   * under the same row lock.
   */
  async startFillingSession(body: CreateFillingSession, principal: AuthPrincipal) {
    if (!body.packageOrderId) throw new ConflictException('packageOrderId is required to start a filling session.');
    const packageOrderId = body.packageOrderId;
    return this.db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        select status from packaging.package_order where package_order_id = ${packageOrderId} for update`
      )) as unknown as Array<{ status: string | null }>;
      if (!locked[0]) throw new NotFoundException(`package_order not found: ${packageOrderId}`);
      const current = String(locked[0].status ?? 'DRAFT').toUpperCase();
      if (current !== 'MATERIALS_ISSUED' && current !== 'IN_PROGRESS') {
        throw new ConflictException(
          `Cannot start a filling session on package order ${packageOrderId}: status is ${current} (must be MATERIALS_ISSUED or IN_PROGRESS).`,
        );
      }

      const openSessions = (await tx.execute(sql`
        select count(*)::int as n from packaging.filling_session
         where package_order_id = ${packageOrderId} and coalesce(status, 'ACTIVE') = 'ACTIVE'`
      )) as unknown as Array<{ n: number }>;
      if ((openSessions[0]?.n ?? 0) > 0) {
        throw new ConflictException(`Package order ${packageOrderId} already has an ACTIVE filling session.`);
      }

      if (current === 'MATERIALS_ISSUED') {
        await tx
          .update(packageOrder)
          .set({ status: 'IN_PROGRESS', updatedBy: principal.userId })
          .where(and(eq(packageOrder.packageOrderId, packageOrderId), eq(packageOrder.status, 'MATERIALS_ISSUED')));
      }

      const row = (
        await tx
          .insert(fillingSession)
          .values({
            fillingSessionId: uuidv7(),
            packageOrderId,
            operatorId: body.operatorId ?? null,
            sessionStartDt: body.sessionStartDt ? new Date(body.sessionStartDt) : new Date(),
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!row) throw new Error('insert failed: filling_session');
      return row;
    });
  }

  /** POST /v1/filling-sessions/:id/end — CAS ACTIVE→DONE, stamp the end ts. */
  async endFillingSession(
    sessionId: string,
    body: EndFillingSession,
    principal: AuthPrincipal,
  ) {
    const session = await this.getFillingSession(sessionId);
    if (!session) throw new NotFoundException(`filling_session not found: ${sessionId}`);
    const current = String(session.status ?? 'ACTIVE').toUpperCase();
    if (current !== 'ACTIVE') {
      throw new ConflictException(`Filling session cannot be ended from status ${current} (must be ACTIVE).`);
    }

    const updated = (
      await this.db
        .update(fillingSession)
        .set({
          sessionEndDt: body.sessionEndDt ? new Date(body.sessionEndDt) : new Date(),
          status: 'DONE',
          updatedBy: principal.userId,
        })
        .where(and(eq(fillingSession.fillingSessionId, sessionId), eq(fillingSession.status, 'ACTIVE')))
        .returning()
    )[0];
    if (!updated) {
      throw new ConflictException(`Filling session ${sessionId} was moved off ACTIVE by a concurrent request; refusing this stale end.`);
    }
    return updated;
  }

  async listFillingSessions(
    query: ListQuery,
  ): Promise<Page<typeof fillingSession.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(fillingSession)
      .where(query.cursor ? lt(fillingSession.fillingSessionId, query.cursor) : undefined)
      .orderBy(desc(fillingSession.fillingSessionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.fillingSessionId);
  }

  async getFillingSession(id: string) {
    return (
      await this.db
        .select()
        .from(fillingSession)
        .where(eq(fillingSession.fillingSessionId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── flow: record filling (+ optional outbox) ─────────────────────── */

  /**
   * POST /v1/filling-sessions/:id/details — append a filling_session_details row and emit the
   * optional `packaging.filling.done` signal. One transaction so the event is published iff the
   * detail committed. RP-FAC2: guarded — a session that already ended (DONE) can no longer record
   * fill/reject quantities.
   */
  async recordFilling(sessionId: string, body: RecordFilling, principal: AuthPrincipal) {
    const session = await this.getFillingSession(sessionId);
    if (!session) throw new NotFoundException(`filling_session not found: ${sessionId}`);
    if (String(session.status ?? 'ACTIVE').toUpperCase() !== 'ACTIVE') {
      throw new ConflictException(`Filling session ${sessionId} is not ACTIVE — cannot record filling.`);
    }

    return this.db.transaction(async (tx) => {
      const detailId = uuidv7();
      const detail = (
        await tx
          .insert(fillingSessionDetails)
          .values({
            fillingSessionDetailId: detailId,
            fillingSessionId: sessionId,
            filledQty: num(body.filledQty),
            rejectedQty: num(body.rejectedQty),
            uomId: body.uomId ?? null,
            recordedDt: body.recordedDt ? new Date(body.recordedDt) : new Date(),
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!detail) throw new Error('insert failed: filling_session_details');

      await recordOutbox(
        tx,
        outbox,
        packagingEvents.fillingDone,
        { fillingSessionId: sessionId, fillingSessionDetailId: detailId },
        sessionId,
      );

      return detail;
    });
  }

  async listFillingSessionDetails(
    query: ListQuery,
  ): Promise<Page<typeof fillingSessionDetails.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(fillingSessionDetails)
      .where(
        query.cursor
          ? lt(fillingSessionDetails.fillingSessionDetailId, query.cursor)
          : undefined,
      )
      .orderBy(desc(fillingSessionDetails.fillingSessionDetailId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.fillingSessionDetailId);
  }

  async getFillingSessionDetail(id: string) {
    return (
      await this.db
        .select()
        .from(fillingSessionDetails)
        .where(eq(fillingSessionDetails.fillingSessionDetailId, id))
        .limit(1)
    )[0] ?? null;
  }
}
