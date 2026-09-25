/**
 * RolePermissionResolver — the main app box's `PermissionResolver` (bound under
 * `PERMISSION_RESOLVER` by `ClusterOrgModule`). Resolves a verified access token's `roles` to
 * the flattened permission set server-side, over role_master → role_permission_mapping →
 * permission_master, so the token no longer has to carry that list (an owner's 257 permissions
 * made a 12 KB token nginx refused as a header). The token's own `perms` claim is ignored here:
 * this process has the IAM tables, so it always reads the current grants.
 *
 * CACHE. A short-lived in-process cache keyed by (generation, sorted role set), so a request
 * costs a Map lookup rather than a join. `invalidate()` bumps the generation and clears the map;
 * `SecurityService` calls it after every role↔permission grant or revoke, so the process that
 * made the change enforces it on the very next request. Any other process sees it within
 * ROLE_PERMISSION_CACHE_TTL_MS, far inside the access-token lifetime (JWT_ACCESS_TTL), which is
 * how long a grant change took to reach a held session before (it only reached the token on
 * refresh). A load that started before an invalidation is not cached, so a revoke can never be
 * overwritten by a stale read that finished after it.
 *
 * The token's `pv` claim does not serve as the cache version: it is fixed when the token is
 * minted and nothing bumps it, so a grant change made after minting could never reach it. The
 * version that matters is server-side, which is the generation below.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { PermissionClaims, PermissionResolver } from '@core/backend-kernel';
import { ORG_DB, orgSchema, type OrgDb } from '../cluster-org.tokens.js';

/** How long a resolved role set is reused before it is read again from the IAM tables. */
export const ROLE_PERMISSION_CACHE_TTL_MS = 30_000;

/** Role sets come from signed tokens only, so the key space is small; this is a backstop. */
const MAX_CACHED_ROLE_SETS = 256;

@Injectable()
export class RolePermissionResolver implements PermissionResolver {
  private generation = 0;
  private readonly cache = new Map<string, { perms: readonly string[]; expiresAt: number }>();

  constructor(@Inject(ORG_DB) private readonly db: OrgDb) {}

  resolve(claims: PermissionClaims): Promise<string[]> {
    return this.permissionsForRoles(claims.roles);
  }

  async permissionsForRoles(roles: readonly string[]): Promise<string[]> {
    const roleSet = [...new Set(roles)].sort();
    if (roleSet.length === 0) return [];
    const generation = this.generation;
    const key = `${generation}\u0000${roleSet.join('\u0000')}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return [...hit.perms];

    const perms = await this.load(roleSet);
    if (generation === this.generation) {
      if (this.cache.size >= MAX_CACHED_ROLE_SETS) this.cache.clear();
      this.cache.set(key, { perms, expiresAt: now + ROLE_PERMISSION_CACHE_TTL_MS });
    }
    return [...perms];
  }

  /** Drop every cached role set. Called after any role↔permission grant change. */
  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
  }

  /** Clock seam (a test advances it past the TTL instead of sleeping). */
  protected now(): number {
    return Date.now();
  }

  private async load(roleCodes: string[]): Promise<string[]> {
    const { roleMaster, rolePermissionMapping, permissionMaster } = orgSchema;
    const rows = await this.db
      .selectDistinct({ code: permissionMaster.permissionCode })
      .from(roleMaster)
      .innerJoin(rolePermissionMapping, eq(rolePermissionMapping.roleId, roleMaster.roleId))
      .innerJoin(permissionMaster, eq(permissionMaster.permissionId, rolePermissionMapping.permissionId))
      .where(inArray(roleMaster.roleCode, roleCodes));
    return rows.map((r) => r.code).filter((c): c is string => c !== null);
  }
}
