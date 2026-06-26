/**
 * The `production` Postgres schema — RAW AROMACHEM Phase-1A.
 * Built table-for-table to the Phase-1A Data Dictionary. Header->line references within the
 * production schema are real FKs; cross-schema references (formula/inventory/quality/iam/
 * location/platform) are id-only soft refs (no cross-schema FK — extraction-safe modular monolith).
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const production = pgSchema("production");
