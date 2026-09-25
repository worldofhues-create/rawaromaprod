/**
 * PermissionResolver — how `JwtAuthGuard` turns a verified access token into the principal's
 * flattened `domain:resource:action` permission set. Bound under `PERMISSION_RESOLVER` by each
 * composition root; `JwtAuthGuard` requires one, so a process that forgets to bind it fails at
 * boot, never silently at request time.
 *
 * WHY THIS EXISTS (RawProd release fix, lane token-rp). The access token used to carry every
 * permission inline. An owner holds 257, so the JWT was 12,355 bytes, over nginx's 8 KB default
 * header limit, and owners got "400 Request Header Or Cookie Too Large" on their first write.
 * The token now carries `roles` + `pv` and only the small VAULT-SCOPED subset below:
 *
 *   - The main app box (`AppModule`) binds cluster-org's `RolePermissionResolver`, which
 *     resolves the full set from the token's `roles` against the IAM tables on every request
 *     (short-lived in-process cache, invalidated on every role-grant write in that process).
 *   - The Vault box (`VaultAppModule`) holds no main-DB credential by design, so it cannot
 *     resolve from roles. It binds `TokenCarriedPermissionResolver`, which returns the
 *     vault-scoped subset the token still carries. That subset is exactly the namespaces every
 *     Vault route checks (`formula:*`, `vault:*`), so a Vault decision reads the same codes it
 *     always did, with the same access-token-lifetime staleness, under the same never-implicit
 *     rule in `PermissionsGuard`.
 */
import { Injectable } from '@nestjs/common';

/** The two verified access-token claims a resolver may read (`AccessClaims.roles`/`.perms`).
 *  Spelled out here rather than imported so this file and `jwt.service.ts` (which imports the
 *  pattern below) never form an import cycle. */
export interface PermissionClaims {
  roles: string[];
  perms: string[];
}

export interface PermissionResolver {
  /** The permission codes the caller holds for this request. Must fail closed: a caller the
   *  resolver cannot vouch for gets fewer permissions, never more. */
  resolve(claims: PermissionClaims): Promise<string[]>;
}

/** DI token for the process's `PermissionResolver`. */
export const PERMISSION_RESOLVER = Symbol('PERMISSION_RESOLVER');

/**
 * The only permission namespaces an access token carries inline: the ones the Vault box's
 * routes check. A naming convention (the same kind `PermissionsGuard`'s NEVER_IMPLICIT_PATTERNS
 * uses) so this domain-free kernel never imports the formula cluster. `JwtService` applies it
 * both when it signs and when it verifies, so no caller can put the full list back into a
 * token, and an older full-list token is read as the vault-scoped subset.
 */
export const TOKEN_CARRIED_PERMISSION_PATTERNS: readonly RegExp[] = [/^formula:/, /^vault:/];

export function isTokenCarriedPermission(code: string): boolean {
  return TOKEN_CARRIED_PERMISSION_PATTERNS.some((re) => re.test(code));
}

/** The Vault box's resolver: the vault-scoped subset the token carries, nothing else. */
@Injectable()
export class TokenCarriedPermissionResolver implements PermissionResolver {
  async resolve(claims: PermissionClaims): Promise<string[]> {
    return claims.perms.filter(isTokenCarriedPermission);
  }
}
