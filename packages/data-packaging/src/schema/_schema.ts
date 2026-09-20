/**
 * The `packaging` Postgres schema — RAW AROMACHEM Phase-1A finished-goods packaging
 * (product → SKU, packaging material + BOM, package orders, filling sessions, FG batches).
 * Built table-for-table to the Phase-1A Data Dictionary. Within-schema references are real
 * FKs (product_category → product → product_sku); cross-schema references (formula/brand/
 * location/oil_batch) are id-only soft refs (no cross-schema FK — extraction-safe).
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const packaging = pgSchema("packaging");
