/**
 * Sales order tables (Phase-1A Data Dictionary): SALES_ORDER, SALES_ORDER_ITEMS.
 * sales_order_items → sales_order is an in-schema FK. customer_id is a soft ref to
 * customer_master per the dictionary (id-only, no FK); product_sku/location/currency/
 * uom refs are soft refs to other schemas (no cross-schema FK).
 */
import { date, index, numeric, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
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
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("sales_order_so_number_uq").on(t.soNumber),
    index("sales_order_customer_idx").on(t.customerId),
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
