/**
 * IMPORT-RP — one permission per import kind, held by exactly the roles that hold the single-record
 * action it mirrors. A sheet must never do what the form cannot, for any role, now or after the next
 * edit to scripts/ra-roles.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';
import { IMP_PERMISSIONS, IMPORT_MIRRORS } from '../../../../scripts/imp-grants.js';
import { isTokenCarriedPermission } from '@core/backend-kernel';
import { FORMULAS } from '@ra/cluster-formula';
import { FACTORY_IMPORT_SPECS } from '../imports/kind-specs.js';

const holders = (p: string) => ROLES.filter((r) => r.select(p)).map((r) => r.code).sort();
const SPECS = [...FACTORY_IMPORT_SPECS, FORMULAS];

test('every import permission and its mirror are in the catalogue the seed writes', () => {
  for (const p of [...IMP_PERMISSIONS, ...Object.keys(IMPORT_MIRRORS), ...Object.values(IMPORT_MIRRORS)]) assert.ok(RA_PERMISSIONS.includes(p), `${p} is not in RA_PERMISSIONS`);
  assert.equal(new Set(RA_PERMISSIONS).size, RA_PERMISSIONS.length, 'no permission is listed twice');
});

test('each import permission is held by exactly the roles that hold the single-record permission it mirrors', () => {
  for (const [imp, single] of Object.entries(IMPORT_MIRRORS)) {
    assert.deepEqual(holders(imp), holders(single), `${imp} must be held by exactly the holders of ${single}`);
    assert.ok(holders(imp).length > 0, `${imp} is held by nobody`);
  }
});

test('every import kind is gated on a permission of its own, and the registry and the grants file name the same mirror', () => {
  const seen = new Set<string>();
  for (const spec of SPECS) {
    assert.ok(!seen.has(spec.permission), `${spec.kind} shares its permission with another kind`);
    seen.add(spec.permission);
    assert.equal(IMPORT_MIRRORS[spec.permission], spec.mirrors[0], `${spec.kind}: kind-specs and imp-grants disagree about the mirror`);
  }
});

test('the formula rule: only a role that may read a formula in the Vault may upload one, and the owner may not', () => {
  const p = FORMULAS.permission;
  assert.equal(p, 'vault:formula_import:write');
  assert.equal(FORMULAS.secret, true);
  assert.deepEqual(holders(p), ['formulator']);
  for (const role of holders(p)) assert.ok(ROLES.find((r) => r.code === role)!.select('formula:actual:read'), `${role} uploads formulas but may not read one`);
  for (const role of ['owner', 'admin', 'procurement', 'production', 'compounding', 'mixer', 'picker', 'verifier', 'qc', 'warehouse', 'sales']) {
    assert.equal(ROLES.find((r) => r.code === role)?.select(p) ?? false, false, `${role} must not hold ${p}`);
  }
  // The Vault box reads permissions from the token alone: this one must ride in it.
  assert.equal(isTokenCarriedPermission(p), true);
});

test('the main-box import permissions are not vault-scoped, so they never ride in a token and are resolved from roles', () => {
  for (const spec of FACTORY_IMPORT_SPECS) assert.equal(isTokenCarriedPermission(spec.permission), false, spec.kind);
});
