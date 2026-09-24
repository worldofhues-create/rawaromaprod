/**
 * G1/PB-08 (FINAL_OS §2.3/§41, ledger PB-08) — seed-catalog hard invariant for the sales
 * manual-continuity break-glass permission, in the same DB-free style
 * ra-roles-s1-invariants.test.ts already established: exercised for real at seed time by
 * scripts/db-seed.ts's grantRole() (which throws on any violation), and locked in here as a
 * fast regression test that runs on every `pnpm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES,
  MANUAL_CONTINUITY_PERMISSION,
  MANUAL_CONTINUITY_ROLES,
} from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

function grantOf(roleCode: string): string[] {
  const role = ROLES.find((r) => r.code === roleCode);
  assert.ok(role, `role '${roleCode}' must exist in the seed catalog`);
  return RA_PERMISSIONS.filter((p) => role!.select(p));
}

test('sales:manual_continuity:write exists in the permission catalogue', () => {
  assert.ok(RA_PERMISSIONS.includes(MANUAL_CONTINUITY_PERMISSION));
});

test('sales:manual_continuity:write is held ONLY by owner + admin', () => {
  for (const role of ROLES) {
    const holds = grantOf(role.code).includes(MANUAL_CONTINUITY_PERMISSION);
    if (MANUAL_CONTINUITY_ROLES.includes(role.code)) {
      assert.ok(holds, `role '${role.code}' should hold ${MANUAL_CONTINUITY_PERMISSION}`);
    } else {
      assert.ok(!holds, `role '${role.code}' must NOT hold ${MANUAL_CONTINUITY_PERMISSION}`);
    }
  }
});

test('sales role specifically does not hold manual-continuity despite its otherwise-blanket sales:* grant', () => {
  assert.ok(!grantOf('sales').includes(MANUAL_CONTINUITY_PERMISSION));
  // ...but keeps the ordinary write permissions the break-glass path replaced for it.
  assert.ok(grantOf('sales').includes('sales:sales_order:write'));
  assert.ok(grantOf('sales').includes('sales:sales_order_items:write'));
});

test('no factory role (production/compounding/filling/packaging/warehouse/qc/receiving/procurement) holds manual-continuity', () => {
  const factoryRoles = ['production', 'compounding', 'filling', 'packaging', 'warehouse', 'qc', 'receiving', 'procurement'];
  for (const code of factoryRoles) {
    assert.ok(!grantOf(code).includes(MANUAL_CONTINUITY_PERMISSION), `factory role '${code}' must not hold ${MANUAL_CONTINUITY_PERMISSION}`);
  }
});
