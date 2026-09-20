/**
 * @core/data-iam — identity cluster (iam schema).
 *
 * Template core (doc 10 §2): domain-free auth/RBAC/org foundation reused by every
 * project. Backend imports the table objects for its per-schema Drizzle client; the
 * seed steps are re-exported so a composite seeder can run them in order.
 */
export * from "./schema/index.js";
export { iamSeedSteps } from "./seed.js";
export { IAM_PREREQUISITES } from "./migrate.js";
export {
  DEFAULT_ROLES,
  STARTER_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
} from "./seeds/roles.js";
