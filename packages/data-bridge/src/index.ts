/**
 * @ra/data-bridge — the ALEMBIC↔RawProd channel (bridge schema). The backend cluster
 * imports these table objects for its per-schema Drizzle client; the migrate
 * prerequisites are re-exported for the migrate-all runner.
 */
export * from "./schema/index.js";
export { BRIDGE_PREREQUISITES } from "./migrate.js";
