/**
 * iam schema barrel — every table in the identity cluster (doc 10 §3).
 * drizzle.config.ts points `schema` here; drizzle-kit reads all exports.
 *
 * 14 domain tables + outbox + audit_events:
 *   users, credentials, otps, sessions, devices,
 *   roles, permissions, role_permissions, user_roles, consents,
 *   organizations, org_units, org_members, partners,
 *   outbox, audit_events.
 */
export { iam } from "./_schema.js";

export { users, credentials, otps, sessions, devices } from "./users.js";
export {
  roles,
  permissions,
  rolePermissions,
  userRoles,
  consents,
} from "./rbac.js";
export {
  organizations,
  orgUnits,
  orgMembers,
  partners,
} from "./orgs.js";
export { outbox, auditEvents } from "./crosscutting.js";
