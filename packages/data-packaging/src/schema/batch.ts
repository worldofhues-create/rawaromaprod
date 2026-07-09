/**
 * Finished-good batch tables (Phase-1A Data Dictionary): FINISHED_GOOD_BATCH_MASTER,
 * FINISHED_GOODS_BATCH_CONSUMPTION.
 *
 * In-schema FK: finished_good_batch_master → finished_goods_batch_consumption.
 * package_order/product_sku/consumed_for_document/uom are id-only soft refs.
 */
import { date, index, numeric, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { packaging } from "./_schema.js";

/** FINISHED_GOOD_BATCH_MASTER — package_order/product_sku are soft refs. */
export const finishedGoodBatchMaster = packaging.table(
  "finished_good_batch_master",
  {
    finishedGoodBatchId: dictPk("finished_good_batch_id"),
    packageOrderId: uuid("package_order_id"), // soft ref → package_order (dict marks soft)
    productSkuId: uuid("product_sku_id"), // soft ref → product_sku (dict marks soft)
    batchNumber: varchar("batch_number", { length: 50 }),
    producedQty: numeric("produced_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    manufacturingDate: date("manufacturing_date"),
    expiryDate: date("expiry_date"),
    ...metaColumns(),
  },
  (t) => [
    index("finished_good_batch_master_order_idx").on(t.packageOrderId),
    index("finished_good_batch_master_sku_idx").on(t.productSkuId),
  ],
);

/** FINISHED_GOODS_BATCH_CONSUMPTION — finished_good_batch_master is in-schema FK. */
export const finishedGoodsBatchConsumption = packaging.table(
  "finished_goods_batch_consumption",
  {
    finishedGoodsBatchConsumptionId: dictPk("finished_goods_batch_consumption_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id").references(
      () => finishedGoodBatchMaster.finishedGoodBatchId,
    ),
    consumedForDocumentId: uuid("consumed_for_document_id"), // soft ref (polymorphic)
    consumedQty: numeric("consumed_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    consumedDt: timestamp("consumed_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("finished_goods_batch_consumption_batch_idx").on(t.finishedGoodBatchId),
  ],
);

/**
 * FINISHED_GOOD_RESERVATION — soft-allocates finished-good stock so it can't be dispatched or
 * re-promised twice (the FG analogue of inventory.stock_reservation, which is RM-only). An FG
 * batch's available-to-promise = produced_qty − sum(dispatch_items.dispatched_qty) −
 * sum(finished_goods_batch_consumption.consumed_qty) − sum(active reserved_qty). A reservation is
 * ACTIVE while released_dt IS NULL. `channel` tags who the stock is held for (WEB / OFFLINE /
 * GENERAL) — the seam the two-console model uses to grant web-sellable stock. finished_good_batch
 * is the one in-schema FK; sku / document / uom are dict-soft refs.
 */
export const finishedGoodReservation = packaging.table(
  "finished_good_reservation",
  {
    finishedGoodReservationId: dictPk("finished_good_reservation_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id").references(
      () => finishedGoodBatchMaster.finishedGoodBatchId,
    ),
    productSkuId: uuid("product_sku_id"), // soft ref → product_sku (denormalised for by-SKU ATP)
    reservedQty: numeric("reserved_qty", { precision: 18, scale: 4 }),
    channel: varchar("channel", { length: 30 }), // WEB | OFFLINE | GENERAL
    reservedForDocumentId: uuid("reserved_for_document_id"), // soft ref → sales.sales_order (polymorphic)
    reservedDt: timestamp("reserved_dt", { withTimezone: true }),
    releasedDt: timestamp("released_dt", { withTimezone: true }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [
    index("finished_good_reservation_batch_idx").on(t.finishedGoodBatchId),
    index("finished_good_reservation_sku_idx").on(t.productSkuId),
    index("finished_good_reservation_document_idx").on(t.reservedForDocumentId),
  ],
);
