/**
 * @ra/data-production — Phase-1A production schema: production plan/order, material pick/issue,
 * secure mixing, oil batch master + consumption/event history, production QC. Built
 * table-for-table to the Data Dictionary.
 */
export * from "./schema/index.js";
export { PRODUCTION_PREREQUISITES } from "./migrate.js";
