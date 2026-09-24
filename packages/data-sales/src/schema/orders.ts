/**
 * Sales order tables (Phase-1A Data Dictionary): SALES_ORDER, SALES_ORDER_ITEMS.
 * sales_order_items → sales_order is an in-schema FK. customer_id is a soft ref to
 * customer_master per the dictionary (id-only, no FK); product_sku/location/currency/
 * uom refs are soft refs to other schemas (no cross-schema FK).
 *
 * `origin`/`alembic_ref` (G1/PB-08, FINAL_OS §2.3/§41): RawProd must not be an independent
 * commercial-order writer — a sales order should originate from an ALEMBIC bridge requirement,
 * not a direct manual POST. Until that importer path exists, every row is created via the
 * break-glass continuity path (OrdersController/OrdersService) and stamped
 * `origin = 'MANUAL_CONTINUITY'`; a future bridge-importer-created row would stamp
 * `origin = 'ALEMBIC_BRIDGE'` and populate `alembic_ref` with the requirement id it came from.
 * Both columns are nullable/soft so existing rows (created before this column existed) and any
 * other creation path never break on a NOT NULL/FK constraint.
 */
import { date, index, numeric, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { sales } from "./_schema.js";

/** SALES_ORDER */
export const salesOrder = sales.table(
  "sales_order",
  {
    salesOrderId: dictPk("sales_order_id"),
    soNumber: varchar("so_number", { length: 50 }),
    customerId: uuid("customer_id"),
    orderDate: date("order_date"),
    // soft refs → other schemas
    deliveryLocationId: uuid("delivery_location_id"),
    currencyId: uuid("currency_id"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }),
    // G1/PB-08 — see file header. 'MANUAL_CONTINUITY' | 'ALEMBIC_BRIDGE' (soft-enum: no other
    // table in this schema group enforces its status-like columns via a DB CHECK either).
    origin: varchar("origin", { length: 30 }),
    // soft ref → the ALEMBIC-side requirement/aggregate id this order reconciles against, when
    // known — null for a manual-continuity order with no such requirement.
    alembicRef: uuid("alembic_ref"),
    continuityReason: text("continuity_reason"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("sales_order_so_number_uq").on(t.soNumber),
    index("sales_order_customer_idx").on(t.customerId),
    index("sales_order_alembic_ref_idx").on(t.alembicRef),
  ],
);

/** SALES_ORDER_ITEMS */
export const salesOrderItems = sales.table(
  "sales_order_items",
  {
    salesOrderItemId: dictPk("sales_order_item_id"),
    salesOrderId: uuid("sales_order_id").references(() => salesOrder.salesOrderId),
    // soft ref → packaging.product_sku
    productSkuId: uuid("product_sku_id"),
    orderedQty: numeric("ordered_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    rate: numeric("rate", { precision: 18, scale: 4 }),
    amount: numeric("amount", { precision: 18, scale: 4 }),
    ...metaColumns(),
  },
  (t) => [
    index("sales_order_items_order_idx").on(t.salesOrderId),
    index("sales_order_items_sku_idx").on(t.productSkuId),
  ],
);
