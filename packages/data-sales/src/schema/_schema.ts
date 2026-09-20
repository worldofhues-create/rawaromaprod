/**
 * The `sales` Postgres schema — RAW AROMACHEM Phase-1A (customers, transporters,
 * sales orders, dispatch). Built table-for-table to the Phase-1A Data Dictionary.
 * Within-schema references are real FKs; cross-schema references (product_sku,
 * finished_good_batch, location, currency, address, contact) are id-only soft refs
 * (no cross-schema FK — extraction-safe modular monolith).
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const sales = pgSchema("sales");
