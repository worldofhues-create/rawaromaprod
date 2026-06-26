/**
 * @ra/data-procurement — procurement cluster (procurement schema). Domain layer (@ra),
 * built to the @mfg-generic shape (vendor + procurement are reusable across factories).
 * The backend cluster imports these table objects for its per-schema Drizzle client.
 */
export * from "./schema/index.js";
export { PROCUREMENT_PREREQUISITES } from "./migrate.js";
