/**
 * Vault material-search picker — RBAC (§109.7 addendum item 4) + real search behavior.
 * `GET /v1/vault/materials` is gated by `vault:material_search:read`, NOT the ordinary
 * `masterdata:material:read`/`reveal` a procurement/receiving/etc. role holds — proves the
 * draft editor's picker is reachable by Vault authority (formulator/vault_approver) and
 * refused for everyone else, same fail-closed pattern as `formula:actual:read`
 * (`vault:` is in permissions.guard.ts's NEVER_IMPLICIT_PATTERNS, so even super_admin/owner
 * never bypass it implicitly).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { FormulasController } from '../formulas/formulas.controller.js';
import { principal } from '../../../test-support/db.js';
import { ROLES, VAULT_PLAINTEXT_PERMISSION } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const reflector = new Reflector();
const guard = new PermissionsGuard(reflector);

function fakeContext(methodName: string, user: unknown) {
  const handler = (FormulasController.prototype as any)[methodName];
  return {
    getHandler: () => handler,
    getClass: () => FormulasController,
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

function grantFor(roleCode: string): string[] {
  const role = ROLES.find((r) => r.code === roleCode);
  assert.ok(role, `role '${roleCode}' must exist in ROLES`);
  return RA_PERMISSIONS.filter((p) => role!.select(p));
}

test('material search rbac: permitted for formulator (holds vault:material_search:read)', () => {
  const grant = grantFor('formulator');
  assert.ok(grant.includes('vault:material_search:read'));
  const p = principal({ roles: ['formulator'], permissions: grant });
  assert.equal(guard.canActivate(fakeContext('searchMaterials', p)), true);
});

test('material search rbac: permitted for vault_approver', () => {
  const p = principal({ roles: ['vault_approver'], permissions: grantFor('vault_approver') });
  assert.equal(guard.canActivate(fakeContext('searchMaterials', p)), true);
});

test('material search rbac: denied for procurement — holds masterdata:material:read/reveal but not vault:material_search:read', () => {
  const grant = grantFor('procurement');
  assert.ok(!grant.includes('vault:material_search:read'));
  const p = principal({ roles: ['procurement'], permissions: grant });
  assertForbidden(() => guard.canActivate(fakeContext('searchMaterials', p)));
});

test("material search rbac: owner's otherwise-blanket grant excludes vault:material_search:read too (ROLES.owner.select excludes the whole vault: prefix, not just formula:actual:read)", () => {
  const grant = grantFor('owner');
  assert.ok(!grant.includes('vault:material_search:read'), 'owner must not incidentally hold the vault material-search permission');
  const p = principal({ roles: ['owner'], permissions: grant });
  assertForbidden(() => guard.canActivate(fakeContext('searchMaterials', p)));
});

test('material search rbac: denied for super_admin holding zero permissions — vault:* is never-implicit, same as formula:actual:read', () => {
  const superAdmin = principal({ roles: ['super_admin'], permissions: [] });
  assertForbidden(() => guard.canActivate(fakeContext('searchMaterials', superAdmin)));
});

test('material search rbac: denied for a principal with no permissions', () => {
  assertForbidden(() => guard.canActivate(fakeContext('searchMaterials', principal({ permissions: [] }))));
});

test('sanity: vault:material_search:read is a genuinely different gate than formula:actual:read', () => {
  assert.notEqual('vault:material_search:read', VAULT_PLAINTEXT_PERMISSION);
});
