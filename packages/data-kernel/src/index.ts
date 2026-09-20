/**
 * @core/data-kernel — domain-free Drizzle helpers + runners.
 *
 * Ships with the template, reused verbatim by every project and every cluster.
 * Contains NO tables — only column-set helpers, geometry/outbox/audit factories,
 * the UUIDv7 utility, and migration/seed runner stubs (doc 10 §2 reusability map).
 */

// Column-set helpers (baseColumns, softDelete, money, currency + dictionary-style)
export {
  baseColumns,
  softDelete,
  money,
  currency,
  PARTIAL_ACTIVE_WHERE,
  dictPk,
  metaColumns,
} from "./columns.js";

// PostGIS geometry helpers (4326)
export { geoPoint, geoPolygon, geoMultiPolygon } from "./geo.js";

// Cross-cutting per-schema table factories
export { outboxTable } from "./outbox.js";
export { auditTable } from "./audit.js";

// UUIDv7
export { uuidv7, UUIDV7_SQL } from "./uuid.js";

// Migration + seed runners
export {
  runMigrations,
  runSeeds,
  ensurePrerequisites,
  resolveEnv,
  type Db,
  type Env,
  type SeedStep,
  type SeedResult,
} from "./runner.js";
