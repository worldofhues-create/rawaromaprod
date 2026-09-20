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
 * Pre-generated ids use uuidv7(); status defaults to DRAFT; created_by/updated_by =
 * principal.userId; numerics are stringified at insert (num()); order_date is a plain date
 * string. customer / product_sku / location / currency / uom are dict-soft refs (plain uuid,
 * no FK at this layer); sales_order_items.sales_order_id is the one real in-schema FK.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { SALES_DB, salesSchema, type SalesDb } from '../sales.tokens.js';
import { salesEvents } from '../sales.events.js';
import { num, paginate, type Page } from '../_helpers.js';
import type {
  CreateSalesOrder,
  CreateSalesOrderItem,
  ListQuery,
} from '../sales.dtos.js';

const { salesOrder, salesOrderItems, outbox } = salesSchema;

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

      return { salesOrder: header, items };
    });
  }

  /* ── flow: confirm sales order ────────────────────────────────────── */

  /** POST /v1/sales-orders/:id/confirm — flip status to CONFIRMED + emit the signal. */
  async confirmSalesOrder(id: string, principal: AuthPrincipal) {
    const existing = await this.getSalesOrder(id);
    if (!existing) throw new NotFoundException(`sales_order not found: ${id}`);

    return this.db.transaction(async (tx) => {
      const updated = (
        await tx
          .update(salesOrder)
          .set({ status: 'CONFIRMED', updatedBy: principal.userId })
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

  async createSalesOrderItem(body: CreateSalesOrderItem, principal: AuthPrincipal) {
    const row = (
      await this.db
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
    return row;
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
