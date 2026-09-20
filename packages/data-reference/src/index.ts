/**
 * @ra/data-reference — Phase-1A reference masters (platform schema): country/currency/
 * language/timezone, address, geo location, contact, document, uom, brand. Built
 * table-for-table to the Data Dictionary. Soft-referenced by the rest of the Phase-1A schemas.
 */
export * from "./schema/index.js";
export { PLATFORM_PREREQUISITES } from "./migrate.js";
