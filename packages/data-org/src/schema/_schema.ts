/**
 * The `iam` Postgres schema — RAW AROMACHEM Phase-1A foundation (org + users + security).
 * Built table-for-table to the Phase-1A Data Dictionary. Within-schema references are real
 * FKs; cross-schema references (country/currency/timezone/language/location) are id-only
 * soft refs (no cross-schema FK — extraction-safe modular monolith).
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const iam = pgSchema("iam");
