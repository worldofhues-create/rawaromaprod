/**
 * iam seed data — default roles + a starter permission set (doc 10 §3 + §11 P0).
 *
 * Idempotent: keyed by stable `key`s with ON CONFLICT DO NOTHING. Roles + permissions
 * are master-like data that seeds in ALL envs. `permissions.key` follows
 * `domain:resource:action`; the authoritative typed registry lives in nt-contracts —
 * this is the runtime store, kept in sync by a contracts-driven seed later.
 */

/** Default platform/org roles. `scope`: platform | org. */
export const DEFAULT_ROLES: ReadonlyArray<{
  key: string;
  name: string;
  scope: "platform" | "org";
}> = [
  // Platform-wide internal roles
  { key: "super_admin", name: "Super Admin", scope: "platform" },
  { key: "admin", name: "Administrator", scope: "platform" },
  { key: "ops_manager", name: "Operations Manager", scope: "platform" },
  { key: "ops_agent", name: "Operations Agent", scope: "platform" },
  { key: "inspector", name: "Inspector", scope: "platform" },
  { key: "verifier", name: "Verifier", scope: "platform" },
  { key: "finance", name: "Finance", scope: "platform" },
  { key: "support", name: "Support Agent", scope: "platform" },
  // Consumer / market roles
  { key: "buyer", name: "Buyer", scope: "platform" },
  { key: "owner", name: "Owner / Seller", scope: "platform" },
  { key: "broker", name: "Broker", scope: "org" },
  // Org (builder/partner) roles
  { key: "builder_owner", name: "Builder Org Owner", scope: "org" },
  { key: "builder_admin", name: "Builder Org Admin", scope: "org" },
  { key: "builder_member", name: "Builder Org Member", scope: "org" },
  { key: "partner", name: "Partner", scope: "org" },
];

/**
 * Starter permission set — `domain:resource:action`. Deliberately compact for P0
 * (identity + platform surface); the full registry is generated from nt-contracts.
 */
export const STARTER_PERMISSIONS: ReadonlyArray<{
  key: string;
  description: string;
}> = [
  // iam domain
  { key: "iam:user:read", description: "View users" },
  { key: "iam:user:create", description: "Create users" },
  { key: "iam:user:update", description: "Update users" },
  { key: "iam:user:suspend", description: "Suspend or reactivate a user" },
  { key: "iam:role:read", description: "View roles" },
  { key: "iam:role:assign", description: "Assign roles to users" },
  { key: "iam:permission:read", description: "View permissions" },
  { key: "iam:org:read", description: "View organizations" },
  { key: "iam:org:create", description: "Create organizations" },
  { key: "iam:org:update", description: "Update organizations" },
  { key: "iam:org:manage_members", description: "Manage org membership" },
  // platform domain (control plane)
  { key: "platform:flag:read", description: "View feature flags" },
  { key: "platform:flag:update", description: "Change flag state (kill-switch)" },
  { key: "platform:master:read", description: "View master data" },
  { key: "platform:master:manage", description: "Manage master data items" },
  { key: "platform:geo:read", description: "View geo regions" },
  { key: "platform:geo:manage", description: "Manage geo regions" },
  { key: "platform:theme:manage", description: "Manage portal themes" },
  { key: "platform:content:manage", description: "Manage content blocks" },
  { key: "platform:config:read", description: "View system config" },
  { key: "platform:config:manage", description: "Manage system config" },
  { key: "platform:checklist:manage", description: "Manage checklist templates" },
];

/**
 * Default role → permission grants (by key). super_admin gets everything implicitly
 * in the app; we still seed an explicit baseline for admin/ops so a fresh DB is
 * usable. Keyed by role key + permission key — resolved to ids in the seed step.
 */
export const DEFAULT_ROLE_PERMISSIONS: ReadonlyArray<{
  roleKey: string;
  permissionKeys: string[];
}> = [
  {
    roleKey: "super_admin",
    permissionKeys: STARTER_PERMISSIONS.map((p) => p.key),
  },
  {
    roleKey: "admin",
    permissionKeys: [
      "iam:user:read",
      "iam:user:create",
      "iam:user:update",
      "iam:user:suspend",
      "iam:role:read",
      "iam:role:assign",
      "iam:org:read",
      "iam:org:create",
      "iam:org:update",
      "iam:org:manage_members",
      "platform:flag:read",
      "platform:master:read",
      "platform:master:manage",
      "platform:geo:read",
      "platform:theme:manage",
      "platform:content:manage",
      "platform:config:read",
      "platform:checklist:manage",
    ],
  },
  {
    roleKey: "ops_manager",
    permissionKeys: [
      "iam:user:read",
      "iam:org:read",
      "platform:flag:read",
      "platform:master:read",
      "platform:geo:read",
      "platform:checklist:manage",
    ],
  },
  {
    roleKey: "finance",
    permissionKeys: ["iam:user:read", "platform:config:read"],
  },
];
