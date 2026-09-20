/**
 * @ra/data-inventory — inventory cluster (inventory schema). Domain layer (@ra). Owns gate
 * entries + GRN/lines (M05 receiving), the rm_batches genealogy, the event-sourced
 * stock_movements ledger + inventory_batches projection, and physical audits (M06). The
 * backend cluster imports these table objects for its per-schema Drizzle client; seed steps
 * + prerequisites are re-exported for the migrate-all runner.
 */
export * from "./schema/index.js";
export { inventorySeedSteps } from "./seed.js";
export { INVENTORY_PREREQUISITES } from "./migrate.js";
