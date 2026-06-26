/**
 * @core/data-platform — platform cluster (platform schema).
 *
 * Template core (doc 10 §2): domain-free control plane + geo tree + master engine +
 * flags + themes + content + config, reused by every project. Backend imports the
 * table objects for its per-schema Drizzle client; seed steps are re-exported.
 */
export * from "./schema/index.js";
export { platformSeedSteps } from "./seed.js";
export { PLATFORM_PREREQUISITES } from "./migrate.js";
export {
  INDIA_REGION_TYPES,
  INDORE_REGIONS,
} from "./seeds/geo.js";
export {
  MASTER_TYPES,
  MEASUREMENT_UNITS,
  STARTER_MASTER_ITEMS,
} from "./seeds/masters.js";
