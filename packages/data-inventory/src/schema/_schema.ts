/**
 * The `inventory` Postgres schema handle (data-conventions §1 schema-per-cluster).
 *
 * Owns: gate entries + GRN/lines (M05 receiving), the rm_batches genealogy, the
 * append-only stock_movements ledger + its inventory_batches projection (M06), and
 * physical audits. References to other clusters (po, vendor, material, storage_nodes,
 * uom) are id-only SOFT REFS — no cross-schema FK (extraction-safe). In-schema FKs
 * (grn→lines, grn→rm_batch, audit→lines) are encouraged for parent/child integrity.
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const inventory = pgSchema("inventory");
