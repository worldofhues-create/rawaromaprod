/**
 * @ra/data-location — Phase-1A location schema: sites + warehouse hierarchy
 * (warehouse→floor→zone→rack→shelf→bin) + storage locations, built table-for-table to the
 * Data Dictionary.
 */
export * from "./schema/index.js";
export { LOCATION_PREREQUISITES } from "./migrate.js";
