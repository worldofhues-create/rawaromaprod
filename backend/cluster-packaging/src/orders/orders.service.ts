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
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
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
  fillingSession,
  fillingSessionDetails,
  outbox,
} = packagingSchema;

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

  async listPackageOrders(
    query: ListQuery,
  ): Promise<Page<typeof packageOrder.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(packageOrder)
      .where(query.cursor ? lt(packageOrder.packageOrderId, query.cursor) : undefined)
      .orderBy(desc(packageOrder.packageOrderId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.packageOrderId);
  }

  async getPackageOrder(id: string) {
    return (
      await this.db.select().from(packageOrder).where(eq(packageOrder.packageOrderId, id)).limit(1)
    )[0] ?? null;
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

  /** POST /v1/filling-sessions — open an ACTIVE filling session against a package order. */
  async startFillingSession(body: CreateFillingSession, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(fillingSession)
        .values({
          fillingSessionId: uuidv7(),
          packageOrderId: body.packageOrderId ?? null,
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
  }

  /** POST /v1/filling-sessions/:id/end — stamp the end ts and flip status to DONE. */
  async endFillingSession(
    sessionId: string,
    body: EndFillingSession,
    principal: AuthPrincipal,
  ) {
    const session = await this.getFillingSession(sessionId);
    if (!session) throw new NotFoundException(`filling_session not found: ${sessionId}`);

    const updated = (
      await this.db
        .update(fillingSession)
        .set({
          sessionEndDt: body.sessionEndDt ? new Date(body.sessionEndDt) : new Date(),
          status: 'DONE',
          updatedBy: principal.userId,
        })
        .where(eq(fillingSession.fillingSessionId, sessionId))
        .returning()
    )[0];
    if (!updated) throw new Error('update failed: filling_session');
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
   * detail committed.
   */
  async recordFilling(sessionId: string, body: RecordFilling, principal: AuthPrincipal) {
    const session = await this.getFillingSession(sessionId);
    if (!session) throw new NotFoundException(`filling_session not found: ${sessionId}`);

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
