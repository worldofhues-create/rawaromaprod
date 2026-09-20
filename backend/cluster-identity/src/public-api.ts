/**
 * identity cluster — PUBLIC API (doc 01 §0, doc 06 §10).
 *
 * The ONLY surface other clusters may import from identity. Cross-cluster talk is either
 * an outbox event or a DI'd interface declared here — never a deep import. revenue uses
 * `UserLookup` to fetch KYC details at invoice issue; that is the single sanctioned sync
 * path into identity. Implementations live inside the cluster; consumers depend on the
 * interface + token only.
 */

/** A minimal user view exposed to other clusters (no credentials, no PII beyond contact). */
export interface PublicUser {
  id: string;
  fullName: string;
  mobile: string | null;
  email: string | null;
  status: 'active' | 'suspended' | 'pending';
}

/**
 * The cross-cluster read port into identity. The only sanctioned sync dependency
 * (revenue → identity for invoice KYC). Inject by token; do not import the service.
 */
export interface UserLookup {
  /** Fetch a user by id, or null if absent/deleted. */
  findById(userId: string): Promise<PublicUser | null>;
  /** Resolve several users at once (invoice/batch flows). */
  findManyByIds(userIds: string[]): Promise<PublicUser[]>;
}

/** DI token for `UserLookup`. Consumers: `@Inject(USER_LOOKUP)`. */
export const USER_LOOKUP = Symbol('USER_LOOKUP');
