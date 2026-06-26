/**
 * The `location` Postgres schema — RAW AROMACHEM Phase-1A sites + warehouse hierarchy.
 * Built table-for-table to the Phase-1A Data Dictionary. Within-schema references are real
 * FKs (location→warehouse→floor→zone→rack→shelf→bin); cross-schema references (organization,
 * business unit, address, geo location, contact) are id-only soft refs (no cross-schema FK —
 * extraction-safe modular monolith).
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const location = pgSchema("location");
