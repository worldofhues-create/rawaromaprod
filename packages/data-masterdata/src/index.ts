/**
 * @ra/data-masterdata — masterdata cluster (masterdata schema), built table-for-table to
 * the Phase-1A Data Dictionary: material classification chain (type/category/subcategory/
 * group), material master + alias + QC specs + storage rules + ageing, plus the outbox +
 * audit cross-cutting tables. The backend cluster imports these table objects for its
 * per-schema Drizzle client; the migrate prerequisite is re-exported for the migrate-all
 * runner.
 */
export * from "./schema/index.js";
export { MASTERDATA_PREREQUISITES } from "./migrate.js";
