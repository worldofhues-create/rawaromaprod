/**
 * @ra/data-quality — quality cluster (quality schema). Phase-1A Data Dictionary tables,
 * built table-for-table. The backend cluster imports these table objects for its per-schema
 * Drizzle client; the migrate prerequisites are re-exported for the migrate-all runner.
 */
export * from "./schema/index.js";
export { QUALITY_PREREQUISITES } from "./migrate.js";
