/**
 * Security review S1, items 2 + 4 — seed-catalog hard invariants (pure functions, no DB; the
 * same style production-role.test.ts already established for this file's PRE-EXISTING
 * invariants). Also exercised for real in scripts/db-seed.ts's grantRole() (which throws at
 * seed time on any violation) — this file locks the same facts in as fast, DB-free regression
 * tests that run on every `pnpm test`, not just a `db:seed` invocation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES,
  FORMULA_DECISION_PERMISSIONS,
  FORMULATOR_FORBIDDEN_PERMISSIONS,
  VAULT_APPROVER_FORBIDDEN_PERMISSIONS,
  MANUFACTURING_INSTRUCTION_PERMISSION,
  MANUFACTURING_INSTRUCTION_ROLES,
  VAULT_PLAINTEXT_ROLES,
} from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

function grantOf(roleCode: string): string[] {
  const role = ROLES.find((r) => r.code === roleCode);
  assert.ok(role, `role '${roleCode}' must exist in the seed catalog`);
  return RA_PERMISSIONS.filter((p) => role!.select(p));
}

/* ── item 2: owner never holds a formula-decision permission ────────────────────────────── */

test('item 2: no role outside formulator/vault_approver holds ANY formula-decision permission (owner included)', () => {
  for (const role of ROLES) {
    if (VAULT_PLAINTEXT_ROLES.includes(role.code)) continue;
    const granted = RA_PERMISSIONS.filter((p) => role.select(p));
    const offending = granted.filter((p) => FORMULA_DECISION_PERMISSIONS.has(p));
    assert.deepEqual(
      offending,
      [],
      `role '${role.code}' must not hold formula-decision permission(s) [${offending.join(', ')}]`,
    );
  }
});

test('item 2: owner specifically loses formula_approval:write / formula_access_policy:write / formula_master:write / formula_ingredients:write', () => {
  const ownerGrant = grantOf('owner');
  for (const p of [
    'formula:formula_approval:write',
    'formula:formula_access_policy:write',
    'formula:formula_master:write',
    'formula:formula_ingredients:write',
  ]) {
    assert.ok(!ownerGrant.includes(p), `owner must not hold ${p}`);
  }
});

test('item 2: owner KEEPS every formula:*:read permission (oversight, not decision power)', () => {
  const ownerGrant = grantOf('owner');
  const formulaReads = RA_PERMISSIONS.filter((p) => p.startsWith('formula:') && p.endsWith(':read') && p !== 'formula:actual:read');
  for (const p of formulaReads) {
    assert.ok(ownerGrant.includes(p), `owner should still hold the oversight read ${p}`);
  }
});

test('item 2: owner keeps formula:formula_type_master:write (plain taxonomy, not a Vault decision, held by no Vault role)', () => {
  assert.ok(grantOf('owner').includes('formula:formula_type_master:write'));
  assert.ok(!grantOf('formulator').includes('formula:formula_type_master:write'));
  assert.ok(!grantOf('vault_approver').includes('formula:formula_type_master:write'));
});

test('item 2 SoD: formulator never holds an approve/lock/access-policy decision permission', () => {
  const formulatorGrant = grantOf('formulator');
  for (const p of FORMULATOR_FORBIDDEN_PERMISSIONS) {
    assert.ok(!formulatorGrant.includes(p), `formulator must not hold ${p} (SoD, §108)`);
  }
});

test('item 2 SoD: vault_approver never holds a drafting/seal write permission', () => {
  const vaultApproverGrant = grantOf('vault_approver');
  for (const p of VAULT_APPROVER_FORBIDDEN_PERMISSIONS) {
    assert.ok(!vaultApproverGrant.includes(p), `vault_approver must not hold ${p} (SoD, §108)`);
  }
});

test('item 2: approve/reject/lock permission (formula:formula_approval:write) is vault_approver-only', () => {
  for (const role of ROLES) {
    const granted = grantOf(role.code);
    if (role.code === 'vault_approver') {
      assert.ok(granted.includes('formula:formula_approval:write'));
    } else {
      assert.ok(!granted.includes('formula:formula_approval:write'), `role '${role.code}' must not hold formula:formula_approval:write`);
    }
  }
});

/* ── item 4: manufacturing-instruction read is production+compounding only ──────────────── */

test('item 4: production:manufacturing_instruction:read exists in the permission catalogue', () => {
  assert.ok(RA_PERMISSIONS.includes(MANUFACTURING_INSTRUCTION_PERMISSION));
});

test('item 4: production:manufacturing_instruction:read is held ONLY by production + compounding', () => {
  for (const role of ROLES) {
    const granted = grantOf(role.code);
    const holds = granted.includes(MANUFACTURING_INSTRUCTION_PERMISSION);
    if (MANUFACTURING_INSTRUCTION_ROLES.includes(role.code)) {
      assert.ok(holds, `role '${role.code}' should hold ${MANUFACTURING_INSTRUCTION_PERMISSION}`);
    } else {
      assert.ok(!holds, `role '${role.code}' must NOT hold ${MANUFACTURING_INSTRUCTION_PERMISSION}`);
    }
  }
});

test('item 4: owner specifically does not hold the manufacturing-instruction permission (despite its otherwise-blanket grant)', () => {
  assert.ok(!grantOf('owner').includes(MANUFACTURING_INSTRUCTION_PERMISSION));
});

test('item 4: filling specifically does not hold the manufacturing-instruction permission', () => {
  assert.ok(!grantOf('filling').includes(MANUFACTURING_INSTRUCTION_PERMISSION));
});

/* ── item 6: the sample dashboard comment claim is now literally true ───────────────────── */

test('item 6: owner\'s select predicate never returns true for formula:actual:read or any vault:* permission (unchanged baseline this lane builds on)', () => {
  const ownerRole = ROLES.find((r) => r.code === 'owner')!;
  assert.equal(ownerRole.select('formula:actual:read'), false);
  assert.equal(ownerRole.select('vault:material_search:read'), false);
});
