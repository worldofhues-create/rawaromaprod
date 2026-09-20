/**
 * The `platform` Postgres schema — RAW AROMACHEM Phase-1A reference masters
 * (country/currency/language/timezone, address, geo location, contact, document,
 * uom, brand). Built table-for-table to the Phase-1A Data Dictionary. Within-schema
 * references are real FKs; everything else is an id-only soft ref (no cross-schema FK —
 * extraction-safe modular monolith).
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const platform = pgSchema("platform");
