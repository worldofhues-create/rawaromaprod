/**
 * @ra/data-packaging — Phase-1A packaging schema: product → SKU, packaging material + BOM,
 * package orders + items, filling sessions + details, finished-good batches + consumption.
 * Built table-for-table to the Data Dictionary.
 */
export * from "./schema/index.js";
export { PACKAGING_PREREQUISITES } from "./migrate.js";
