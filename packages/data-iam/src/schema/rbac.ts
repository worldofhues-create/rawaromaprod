/**
 * iam RBAC + consent tables (doc 10 §3).
 *
 * roles × permissions (many-to-many via role_permissions); user_roles assigns roles
 * to users, optionally scoped to an org (so the same person can hold different roles
 * in different orgs — a broker across two agencies — with no schema change).
 * `permissions.key` = `domain:resource:action`; the typed source lives in
 * nt-contracts, the DB is the runtime store.
 */
import { sql } from "drizzle-orm";
import {
  index,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";
import { users } from "./users.js";

/**
 * roles — `key` (e.g. ops_manager) UK, `scope` platform|org.
 */
export const roles = iam.table(
  "roles",
  {
    ...baseColumns(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    scope: text("scope").notNull().default("platform"),
  },
  (t) => [
    uniqueIndex("roles_key_uq").on(t.key),
    index("roles_scope_idx").on(t.scope),
  ],
);

/**
 * permissions — `key` = `domain:resource:action`, UK.
 */
export const permissions = iam.table(
  "permissions",
  {
    ...baseColumns(),
    key: text("key").notNull(),
    description: text("description"),
  },
  (t) => [uniqueIndex("permissions_key_uq").on(t.key)],
);

/**
 * role_permissions — M:N join. Composite PK (role_id, permission_id). Both FKs are
 * in-schema.
 */
export const rolePermissions = iam.table(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index("role_permissions_permission_idx").on(t.permissionId),
  ],
);

/**
 * user_roles — assigns a role to a user, optionally within an org.
 * `org_id` null = platform-wide; it is an id-only SOFT ref (to organizations, same
 * schema, but kept id-only to mirror the cross-cluster convention + allow future org
 * extraction). FKs: user_id, role_id (in-schema).
 *
 * It carries a UUIDv7 surrogate PK (the standard's "UUIDv7 PK everywhere" — and a
 * PK cannot span the nullable org_id). Uniqueness of an assignment is enforced by a
 * unique index over (user_id, role_id, COALESCE(org_id, platform-sentinel)) so a
 * (user, role) pair is distinct per org AND once platform-wide.
 */
export const userRoles = iam.table(
  "user_roles",
  {
    ...baseColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    orgId: uuid("org_id"),
  },
  (t) => [
    // NULL org → a fixed sentinel so the unique index treats "platform-wide" as one
    // distinct slot (NULLs are otherwise never equal, which would allow duplicates).
    uniqueIndex("user_roles_user_role_org_uq").on(
      t.userId,
      t.roleId,
      sql`COALESCE(${t.orgId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    index("user_roles_user_idx").on(t.userId),
    index("user_roles_role_idx").on(t.roleId),
    index("user_roles_org_idx").on(t.orgId),
  ],
);

/**
 * consents — tnc|privacy|marketing acceptance log; granted/revoked timestamps.
 * FK to users (in-schema).
 */
export const consents = iam.table(
  "consents",
  {
    ...baseColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    version: text("version").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("consents_user_idx").on(t.userId),
    index("consents_type_idx").on(t.type),
    // One active consent per (user, type) — re-grant after revoke is a new row.
    uniqueIndex("consents_user_type_active_uq")
      .on(t.userId, t.type)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
