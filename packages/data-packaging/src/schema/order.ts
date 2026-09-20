/**
 * Package-order + filling tables (Phase-1A Data Dictionary): PACKAGE_ORDER, PACKAGE_ORDER_ITEM,
 * FILLING_SESSION, FILLING_SESSION_DETAILS.
 *
 * In-schema FKs: package_order → package_order_item, filling_session → filling_session_details.
 * product_sku/oil_batch/location/packaging_material/operator/uom are id-only soft refs.
 * NOTE: PACKAGE_ORDER_ITEM.issued_qty is BOOLEAN (locked by the dictionary).
 */
import {
  boolean,
  index,
  numeric,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { packaging } from "./_schema.js";

/** PACKAGE_ORDER — product_sku/oil_batch/location are cross-schema/soft refs. */
export const packageOrder = packaging.table(
  "package_order",
  {
    packageOrderId: dictPk("package_order_id"),
    productSkuId: uuid("product_sku_id"), // soft ref → product_sku (dict marks soft)
    oilBatchId: uuid("oil_batch_id"), // soft ref → production.oil_batch_master
    locationId: uuid("location_id"), // soft ref → location
    orderQty: numeric("order_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    plannedStartDt: timestamp("planned_start_dt", { withTimezone: true }),
    plannedEndDt: timestamp("planned_end_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("package_order_sku_idx").on(t.productSkuId),
    index("package_order_oil_batch_idx").on(t.oilBatchId),
    index("package_order_location_idx").on(t.locationId),
  ],
);

/** PACKAGE_ORDER_ITEM — package_order is in-schema FK; issued_qty is BOOLEAN (locked). */
export const packageOrderItem = packaging.table(
  "package_order_item",
  {
    packageOrderItemId: dictPk("package_order_item_id"),
    packageOrderId: uuid("package_order_id").references(() => packageOrder.packageOrderId),
    packagingMaterialId: uuid("packaging_material_id"), // soft ref → packaging_material_master
    requiredQty: numeric("required_qty", { precision: 18, scale: 4 }),
    issuedQty: boolean("issued_qty"), // BOOLEAN per dictionary (locked)
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [
    index("package_order_item_order_idx").on(t.packageOrderId),
    index("package_order_item_material_idx").on(t.packagingMaterialId),
  ],
);

/** FILLING_SESSION — package_order/operator are cross-schema/soft refs. */
export const fillingSession = packaging.table(
  "filling_session",
  {
    fillingSessionId: dictPk("filling_session_id"),
    packageOrderId: uuid("package_order_id"), // soft ref → package_order (dict marks soft)
    operatorId: uuid("operator_id"), // soft ref → iam.user_master
    sessionStartDt: timestamp("session_start_dt", { withTimezone: true }),
    sessionEndDt: timestamp("session_end_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("filling_session_order_idx").on(t.packageOrderId)],
);

/** FILLING_SESSION_DETAILS — filling_session is in-schema FK. */
export const fillingSessionDetails = packaging.table(
  "filling_session_details",
  {
    fillingSessionDetailId: dictPk("filling_session_detail_id"),
    fillingSessionId: uuid("filling_session_id").references(
      () => fillingSession.fillingSessionId,
    ),
    filledQty: numeric("filled_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    rejectedQty: numeric("rejected_qty", { precision: 18, scale: 4 }),
    recordedDt: timestamp("recorded_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("filling_session_details_session_idx").on(t.fillingSessionId)],
);
