/**
 * Dispatch tables (Phase-1A Data Dictionary): DISPATCH_MASTER, DISPATCH_ITEMS.
 * dispatch_items → dispatch_master is an in-schema FK. customer_id / sales_order /
 * sales_order_item / transporter refs are id-only soft refs per the dictionary;
 * finished_good_batch / uom are cross-schema soft refs (no cross-schema FK).
 */
import { date, index, numeric, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { sales } from "./_schema.js";

/** DISPATCH_MASTER */
export const dispatchMaster = sales.table(
  "dispatch_master",
  {
    dispatchId: dictPk("dispatch_id"),
    // soft refs → in-schema sales_order / transporter_master per dictionary
    salesOrderId: uuid("sales_order_id"),
    customerId: uuid("customer_id"),
    dispatchDate: date("dispatch_date"),
    vehicleNumber: varchar("vehicle_number", { length: 20 }),
    transporterId: uuid("transporter_id"),
    ...metaColumns(),
  },
  (t) => [
    index("dispatch_master_customer_idx").on(t.customerId),
    index("dispatch_master_sales_order_idx").on(t.salesOrderId),
    index("dispatch_master_transporter_idx").on(t.transporterId),
  ],
);

/** DISPATCH_ITEMS */
export const dispatchItems = sales.table(
  "dispatch_items",
  {
    dispatchItemId: dictPk("dispatch_item_id"),
    dispatchId: uuid("dispatch_id").references(() => dispatchMaster.dispatchId),
    // soft refs → sales_order_items (in-schema) / packaging.finished_good_batch_master
    salesOrderItemId: uuid("sales_order_item_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id"),
    dispatchedQty: numeric("dispatched_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    ...metaColumns(),
  },
  (t) => [
    index("dispatch_items_dispatch_idx").on(t.dispatchId),
    index("dispatch_items_sales_order_item_idx").on(t.salesOrderItemId),
    index("dispatch_items_fg_batch_idx").on(t.finishedGoodBatchId),
  ],
);
