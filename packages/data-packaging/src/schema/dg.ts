/**
 * PRODUCT_DG_INFO (lane produce, owner requirement 2026-09-29; migration
 * scripts/migrations/2026-09-29-produce.sql) — the dangerous-goods / hazard details a finished-
 * good label prints "where set": UN number, proper shipping name, transport class, packing group,
 * signal word and hazard statements. Entered per product by packaging/compliance from the
 * product's SDS; nothing is inferred. A product with no row prints no DG block.
 */
import { text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { packaging } from "./_schema.js";

export const productDgInfo = packaging.table(
  "product_dg_info",
  {
    productDgInfoId: dictPk("product_dg_info_id"),
    productId: uuid("product_id").notNull(), // soft ref → product_master (dict product table)
    unNumber: varchar("un_number", { length: 10 }),
    properShippingName: text("proper_shipping_name"),
    dgClass: varchar("dg_class", { length: 10 }),
    packingGroup: varchar("packing_group", { length: 5 }),
    signalWord: varchar("signal_word", { length: 20 }),
    hazardStatements: text("hazard_statements"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("product_dg_info_product_uq").on(t.productId)],
);
