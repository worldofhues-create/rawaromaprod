/**
 * PROD-D-6 — who holds lane pf-d's permissions (scripts/pfd-grants.ts): the two review signatures sit
 * with two different roles, so no single non-owner role decides a review alone; qc's blanket
 * quality:* grant does not sweep a signature in; floor roles hold none of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, FLOOR_ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';
import { PFD_PERMISSIONS } from '../../../../scripts/pfd-grants.js';

const grantOf = (code: string) => RA_PERMISSIONS.filter((p) => ROLES.find((x) => x.code === code)!.select(p));
const P = 'production:qc_review:perfumer', A = 'production:qc_review:approve';

test('every pf-d permission is in the catalogue and the owner holds all of them', () => {
  for (const p of PFD_PERMISSIONS) assert.ok(RA_PERMISSIONS.includes(p), p);
  const owner = grantOf('owner');
  for (const p of PFD_PERMISSIONS) assert.ok(owner.includes(p), `owner holds ${p}`);
});

test('the perfumer signature is the formulator\'s, the approver signature the vault approver\'s, never both on one role', () => {
  assert.ok(grantOf('formulator').includes(P));
  assert.ok(!grantOf('formulator').includes(A));
  assert.ok(grantOf('vault_approver').includes(A));
  assert.ok(!grantOf('vault_approver').includes(P));
  for (const r of ROLES) {
    if (r.code === 'owner') continue;
    const g = grantOf(r.code);
    assert.ok(!(g.includes(P) && g.includes(A)), `${r.code} holds both signatures`);
  }
  for (const c of ['qc', 'production', 'admin', 'compounding']) assert.ok(!grantOf(c).some((p) => p === P || p === A), `${c} signs nothing`);
});

test('floor roles hold no pf-d permission; planners read and approve cover', () => {
  for (const c of FLOOR_ROLES) for (const p of PFD_PERMISSIONS) assert.ok(!grantOf(c).includes(p), `${c} holds ${p}`);
  assert.ok(grantOf('production').includes('production:cover_plan:write'));
  assert.ok(grantOf('procurement').includes('production:cover_plan:read'));
  assert.ok(!grantOf('procurement').includes('production:cover_plan:write'));
});
