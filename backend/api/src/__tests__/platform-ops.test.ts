/**
 * Platform Ops console — RBAC coverage (§6/§113). Drives the REAL `PermissionsGuard` against
 * the REAL `@Permissions('platformops:console:read')` metadata on `PlatformOpsController`
 * (same pattern as vault-rbac.test.ts / permissions-guard.test.ts). Proves:
 *   - platform_super_admin's REAL computed grant (scripts/ra-roles.ts `select()` over the
 *     real RA_PERMISSIONS catalogue) passes.
 *   - owner's REAL computed grant — despite being "everything except two exclusions" —
 *     EXCLUDES platformops:console:read (the second exclusion this lane adds; the seed
 *     invariant in scripts/db-seed.ts backs this up server-side too). Without this explicit
 *     exclusion, owner's blanket `p !== VAULT_PLAINTEXT_PERMISSION` predicate would have
 *     granted it implicitly — this test is the regression guard for that.
 *   - admin, and the two factory roles whose selectors read `platform:*` reference data
 *     (procurement, sales) are denied — proving PLATFORM_OPS_PERMISSION's own domain prefix
 *     (`platformops:`, not `platform:`) is not accidentally swept up by their
 *     `startsWith('platform:')` grants.
 *   - a principal with zero permissions is denied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { PlatformOpsController } from '../platform-ops/platform-ops.controller.js';
import { principal } from '../../../test-support/db.js';
import { ROLES, PLATFORM_OPS_PERMISSION } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const reflector = new Reflector();
const guard = new PermissionsGuard(reflector);

function fakeContext(methodName: string, user: unknown) {
  const handler = (PlatformOpsController.prototype as any)[methodName];
  return {
    getHandler: () => handler,
    getClass: () => PlatformOpsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

function assertForbidden(fn: () => unknown) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).status, 403);
    return true;
  });
}

const ROUTES = ['tenants', 'health', 'providers', 'build'] as const;

function grantFor(roleCode: string): string[] {
  const role = ROLES.find((r) => r.code === roleCode);
  assert.ok(role, `role '${roleCode}' must exist in ROLES`);
  return RA_PERMISSIONS.filter((p) => role!.select(p));
}

/* ── permitted: platform_super_admin's real computed grant ─────────────────────────────── */

for (const route of ROUTES) {
  test(`platform ops rbac: PlatformOpsController.${route} — permitted for platform_super_admin's real grant`, () => {
    const grant = grantFor('platform_super_admin');
    assert.ok(grant.includes(PLATFORM_OPS_PERMISSION));
    const p = principal({ roles: ['platform_super_admin'], permissions: grant });
    assert.equal(guard.canActivate(fakeContext(route, p)), true);
  });
}

/* ── denied: owner's real computed grant excludes it (§113, the exclusion this lane adds) ── */

const ownerGrant = grantFor('owner');

test("platform ops rbac: sanity — owner's computed grant is large but excludes platformops:console:read", () => {
  assert.ok(ownerGrant.length > 100, 'owner should still hold nearly every other permission');
  assert.ok(!ownerGrant.includes(PLATFORM_OPS_PERMISSION));
});

for (const route of ROUTES) {
  test(`platform ops rbac: PlatformOpsController.${route} — denied for owner (full grant, minus vault plaintext AND platform ops)`, () => {
    const p = principal({ roles: ['owner'], permissions: ownerGrant });
    assertForbidden(() => guard.canActivate(fakeContext(route, p)));
  });
}

/* ── denied: admin (iam:* only — never matches platformops:) ───────────────────────────── */

for (const route of ROUTES) {
  test(`platform ops rbac: PlatformOpsController.${route} — denied for admin`, () => {
    const p = principal({ roles: ['admin'], permissions: grantFor('admin') });
    assertForbidden(() => guard.canActivate(fakeContext(route, p)));
  });
}

/* ── denied: factory roles whose selectors read platform:* (procurement, sales) ────────── */

for (const roleCode of ['procurement', 'sales', 'production', 'compounding', 'qc', 'warehouse'] as const) {
  test(`platform ops rbac: PlatformOpsController.health — denied for factory role '${roleCode}'`, () => {
    const grant = grantFor(roleCode);
    assert.ok(!grant.includes(PLATFORM_OPS_PERMISSION), `'${roleCode}'s grant must not include ${PLATFORM_OPS_PERMISSION}`);
    const p = principal({ roles: [roleCode], permissions: grant });
    assertForbidden(() => guard.canActivate(fakeContext('health', p)));
  });
}

/* ── denied: no permissions at all ──────────────────────────────────────────────────────── */

test('platform ops rbac: PlatformOpsController.tenants — denied for a principal with no permissions', () => {
  assertForbidden(() => guard.canActivate(fakeContext('tenants', principal({ permissions: [] }))));
});
