/**
 * org cluster — PUBLIC API.
 *
 * The only surface other clusters may import from cluster-org. Cross-cluster reads go
 * through this cold-read port (inject by token); never a deep import into a service or
 * the schema. Resolvers return id + code/name refs only — no credentials, no meta tail.
 */

/** A minimal user view for cross-cluster resolution. */
export interface OrgUserRef {
  userId: string;
  email: string | null;
  userName: string | null;
  organizationId: string | null;
}

/** A minimal organization view for cross-cluster resolution. */
export interface OrgRef {
  organizationId: string;
  organizationCode: string | null;
  organizationName: string | null;
}

/** Cold-read port into the org/iam cluster. */
export interface OrgLookup {
  /** Resolve a user by id (contact + org refs only), or null if absent. */
  findUser(userId: string): Promise<OrgUserRef | null>;
  /** Resolve an organization by id (code/name refs only), or null if absent. */
  findOrg(orgId: string): Promise<OrgRef | null>;
  /** The role ids granted to a user via user_role_mapping. */
  getUserRoleIds(userId: string): Promise<string[]>;
  /**
   * The flattened permission codes a user holds, resolved across
   * user_role_mapping → role_permission_mapping → permission_master.
   */
  getUserPermissionCodes(userId: string): Promise<string[]>;
}

/** DI token for `OrgLookup`. Consumers: `@Inject(ORG_LOOKUP)`. */
export const ORG_LOOKUP = Symbol('ORG_LOOKUP');
