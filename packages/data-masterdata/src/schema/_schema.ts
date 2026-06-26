/**
 * The `masterdata` Postgres schema handle (data-conventions §1 schema-per-cluster).
 *
 * Owns: the 7-level warehouse storage tree (M01), material master + classification +
 * alias + storage rules (M02), and the contact master (M01). Material classification
 * dropdowns (type/category/sub/group) live in platform.master_items and are referenced
 * here by id-only SOFT REFS — no cross-schema FK (extraction-safe).
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const masterdata = pgSchema("masterdata");
