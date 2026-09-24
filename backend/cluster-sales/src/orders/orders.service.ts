/**
 * OrdersService — the sales order document + its child lines: SALES_ORDER,
 * SALES_ORDER_ITEMS. CRUD for both, plus the order FLOW:
 *
 *   createSalesOrder  → insert the sales_order header (total_amount = sum of line amounts)
 *                       + one sales_order_items per line, all in ONE transaction, then record
 *                       a `sales.order.created` outbox event.
 *   confirmSalesOrder → flip status to CONFIRMED and — in the SAME transaction — record a
 *                       `sales.order.confirmed` outbox event.
 *
 * G1/PB-08: create/confirm/createSalesOrderItem are now break-glass MANUAL CONTINUITY actions
 * (the controller already refused the call unless the caller holds
 * `sales:manual_continuity:write` — owner/admin only). Each one, inside the same transaction as
 * its domain write:
 *   1. stamps `origin = 'MANUAL_CONTINUITY'` + `continuity_reason = body.reason` on the order
 *      row (durable, queryable audit trail on the document itself), and
 *   2. calls `emitBridgeManualEvent` to write a `bridge.outbox` row toward ALEMBIC (so it can
 *      reconcile this manually-created/confirmed/amended order against its own commercial
 *      order), and
 *   3. ALSO records the existing cluster-internal `sales.order.manual_continuity` outbox event
 *      (sales.outbox) — a second, independent audit trail for anything already consuming this
 *      cluster's own event stream, not a replacement for #2.
 *
 * Pre-generated ids use uuidv7(); status defaults to DRAFT; created_by/updated_by =
 * principal.userId; numerics are stringified at insert (num()); order_date is a plain date
 * string. customer / product_sku / location / currency / uom are dict-soft refs (plain uuid,
 * no FK at this layer); sales_order_items.sales_order_id is the one real in-schema FK.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { emitBridgeManualEvent, recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { SALES_DB, salesSchema, type SalesDb } from '../sales.tokens.js';
import { salesEvents } from '../sales.events.js';
import { num, paginate, type Page } from '../_helpers.js';
import type {
  CreateSalesOrder,
  CreateSalesOrderItem,
  ListQuery,
  ManualContinuityReason,
} from '../sales.dtos.js';

const { salesOrder, salesOrderItems, outbox } = salesSchema;

const MANUAL_CONTINUITY_ORIGIN = 'MANUAL_CONTINUITY';

@Injectable()
export class OrdersService {
  constructor(@Inject(SALES_DB) private readonly db: SalesDb) {}

  /* ── flow: create sales order with items ──────────────────────────── */

  /**
   * POST /v1/sales-orders — insert the header (total_amount = sum of line amounts) + one line
   * per item, then emit `sales.order.created`. All in one transaction so the event publishes
   * iff the header + lines committed.
   */
  async createSalesOrder(body: CreateSalesOrder, principal: AuthPrincipal) {
    const totalAmount = num(
      body.items.reduce((sum, it) => sum + (it.amount ?? 0), 0),
    );

    return this.db.transaction(async (tx) => {
      const salesOrderId = uuidv7();
      const header = (
        await tx
          .insert(salesOrder)
          .values({
            salesOrderId,
            // Audit LOW: base36 of the full epoch (no truncation) — the last-5-digit form collided
            // every ~100s. Unique per millisecond; the so_number unique index backstops same-ms ties.
            soNumber: (body.soNumber && String(body.soNumber).trim()) || ('SO-' + new Date().toISOString().slice(0, 7).replace('-', '') + '-' + Date.now().toString(36).toUpperCase()),
            customerId: body.customerId,
            orderDate: body.orderDate ?? null,
            deliveryLocationId: body.deliveryLocationId ?? null,
            currencyId: body.currencyId ?? null,
            totalAmount,
            status: 'DRAFT',
            // G1/PB-08 — see class doc. This is the ONLY creation path today, so every row is
            // stamped MANUAL_CONTINUITY until a real ALEMBIC bridge importer exists.
            origin: MANUAL_CONTINUITY_ORIGIN,
            continuityReason: body.reason,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!header) throw new Error('insert failed: sales_order');

      const lineValues = body.items.map((it) => ({
        salesOrderItemId: uuidv7(),
        salesOrderId,
        productSkuId: it.productSkuId ?? null,
        orderedQty: num(it.orderedQty),
        uomId: it.uomId ?? null,
        rate: num(it.rate),
        amount: num(it.amount),
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      }));
      const items = await tx.insert(salesOrderItems).values(lineValues).returning();

      await recordOutbox(
        tx,
        outbox,
        salesEvents.orderCreated,
        { salesOrderId, customerId: body.customerId },
        salesOrderId,
      );
      await recordOutbox(
        tx,
        outbox,
        salesEvents.manualContinuity,
        { salesOrderId, action: 'created', reason: body.reason },
        salesOrderId,
      );
      await emitBridgeManualEvent(tx, 'SalesOrderManualContinuityCreated', salesOrderId, {
        sales_order_id: salesOrderId,
        so_number: header.soNumber,
        customer_id: body.customerId,
        reason: body.reason,
        actor_user_id: principal.userId,
      });

      return { salesOrder: header, items };
    });
  }

  /* ── flow: confirm sales order ────────────────────────────────────── */

  /**
   * POST /v1/sales-orders/:id/confirm — flip status to CONFIRMED + emit the signal.
   * G1/PB-08 break-glass: also stamps the continuity reason and reports to ALEMBIC (see class
   * doc) — `body` is `{ reason }`, required by the controller's zod pipe.
   */
  async confirmSalesOrder(id: string, body: ManualContinuityReason, principal: AuthPrincipal) {
    const existing = await this.getSalesOrder(id);
    if (!existing) throw new NotFoundException(`sales_order not found: ${id}`);

    return this.db.transaction(async (tx) => {
      const updated = (
        await tx
          .update(salesOrder)
          .set({
            status: 'CONFIRMED',
            origin: MANUAL_CONTINUITY_ORIGIN,
            continuityReason: body.reason,
            updatedBy: principal.userId,
          })
          .where(eq(salesOrder.salesOrderId, id))
          .returning()
      )[0];
      if (!updated) throw new Error('update failed: sales_order');

      await recordOutbox(
        tx,
        outbox,
        salesEvents.orderConfirmed,
        { salesOrderId: id },
        id,
      );
      await recordOutbox(
        tx,
        outbox,
        salesEvents.manualContinuity,
        { salesOrderId: id, action: 'confirmed', reason: body.reason },
        id,
      );
      await emitBridgeManualEvent(tx, 'SalesOrderManualContinuityConfirmed', id, {
        sales_order_id: id,
        so_number: updated.soNumber,
        reason: body.reason,
        actor_user_id: principal.userId,
      });

      return updated;
    });
  }

  /* ── sales order (CRUD reads) ─────────────────────────────────────── */

  async listSalesOrders(query: ListQuery): Promise<Page<typeof salesOrder.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(salesOrder)
      .where(query.cursor ? lt(salesOrder.salesOrderId, query.cursor) : undefined)
      .orderBy(desc(salesOrder.salesOrderId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.salesOrderId);
  }

  async getSalesOrder(id: string) {
    return (
      await this.db.select().from(salesOrder).where(eq(salesOrder.salesOrderId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── sales order items (CRUD) ─────────────────────────────────────── */

  /**
   * POST /v1/sales-order-items — standalone item add. G1/PB-08 break-glass: same continuity
   * stamp + bridge report as create/confirm above, keyed to the PARENT order (there is no
   * separate row on sales_order_items to stamp an origin on).
   */
  async createSalesOrderItem(body: CreateSalesOrderItem, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const parent = (
        await tx.select().from(salesOrder).where(eq(salesOrder.salesOrderId, body.salesOrderId)).limit(1)
      )[0];
      if (!parent) throw new NotFoundException(`sales_order not found: ${body.salesOrderId}`);

      const row = (
        await tx
          .insert(salesOrderItems)
          .values({
            salesOrderItemId: uuidv7(),
            salesOrderId: body.salesOrderId,
            productSkuId: body.productSkuId ?? null,
            orderedQty: num(body.orderedQty),
            uomId: body.uomId ?? null,
            rate: num(body.rate),
            amount: num(body.amount),
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!row) throw new Error('insert failed: sales_order_items');

      await tx
        .update(salesOrder)
        .set({ origin: MANUAL_CONTINUITY_ORIGIN, continuityReason: body.reason, updatedBy: principal.userId })
        .where(eq(salesOrder.salesOrderId, body.salesOrderId));

      await recordOutbox(
        tx,
        outbox,
        salesEvents.manualContinuity,
        { salesOrderId: body.salesOrderId, action: 'item_added', reason: body.reason },
        body.salesOrderId,
      );
      await emitBridgeManualEvent(tx, 'SalesOrderManualContinuityItemAdded', body.salesOrderId, {
        sales_order_id: body.salesOrderId,
        sales_order_item_id: row.salesOrderItemId,
        reason: body.reason,
        actor_user_id: principal.userId,
      });

      return row;
    });
  }

  async listSalesOrderItems(
    query: ListQuery,
  ): Promise<Page<typeof salesOrderItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(salesOrderItems)
      .where(query.cursor ? lt(salesOrderItems.salesOrderItemId, query.cursor) : undefined)
      .orderBy(desc(salesOrderItems.salesOrderItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.salesOrderItemId);
  }

  async getSalesOrderItem(id: string) {
    return (
      await this.db
        .select()
        .from(salesOrderItems)
        .where(eq(salesOrderItems.salesOrderItemId, id))
        .limit(1)
    )[0] ?? null;
  }
}
