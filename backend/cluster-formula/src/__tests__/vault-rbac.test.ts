/**
 * Vault RBAC — drives the REAL `PermissionsGuard` against the REAL `@Permissions(...)` +
 * `@FreshAuth()` metadata on `FormulasController.getActualFormula` and
 * `ApprovalsController.approveVersion`/`rejectVersion` (same pattern as
 * `backend/api/src/__tests__/permissions-guard.test.ts` and `production-role.test.ts`).
 * Proves the §107 change this lane makes: `formula:actual:read` never short-circuits via
 * `super_admin`, and the seeded `owner` role's real, computed permission grant
 * (scripts/ra-roles.ts `select()` over the real RA_PERMISSIONS catalogue — not a hand-typed
 * stand-in) does not include it either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { FormulasController } from '../formulas/formulas.controller.js';
import { ApprovalsController } from '../approvals/approvals.controller.js';
import { principal } from '../../../test-support/db.js';
import { ROLES, VAULT_PLAINTEXT_PERMISSION } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const reflector = new Reflector();
const guard = new PermissionsGuard(reflector);

function fakeContext(ControllerClass: Function, methodName: string, user: unknown) {
  const handler = (ControllerClass.prototype as any)[methodName];
  return {
    getHandler: () => handler,
    getClass: () => ControllerClass,
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

/* ── permitted: a principal holding the exact required permission passes ──────────────────── */

test('vault rbac: FormulasController.getActualFormula — permitted for a principal holding formula:actual:read', () => {
  const p = principal({ roles: ['formulator'], permissions: [VAULT_PLAINTEXT_PERMISSION] });
  assert.equal(guard.canActivate(fakeContext(FormulasController, 'getActualFormula', p)), true);
});

test('vault rbac: ApprovalsController.approveVersion — permitted for a principal holding formula:formula_approval:write', () => {
  const p = principal({ roles: ['vault_approver'], permissions: ['formula:formula_approval:write'] });
  assert.equal(guard.canActivate(fakeContext(ApprovalsController, 'approveVersion', p)), true);
});

/* ── denied: a principal with no permissions is refused ────────────────────────────────────── */

test('vault rbac: FormulasController.getActualFormula — denied for a principal with no permissions', () => {
  assertForbidden(() =>
    guard.canActivate(fakeContext(FormulasController, 'getActualFormula', principal({ permissions: [] }))),
  );
});

test('vault rbac: ApprovalsController.approveVersion — denied for a principal with no permissions', () => {
  assertForbidden(() =>
    guard.canActivate(fakeContext(ApprovalsController, 'approveVersion', principal({ permissions: [] }))),
  );
});

/* ── owner-without-vault-perm denied: owner's REAL computed grant excludes it (§107) ───────── */

const ownerRole = ROLES.find((r) => r.code === 'owner');
const ownerGrant = RA_PERMISSIONS.filter((p) => ownerRole!.select(p));

test('vault rbac: sanity — owner\'s computed grant is large but excludes formula:actual:read', () => {
  assert.ok(ownerGrant.length > 100, 'owner should still hold nearly every other permission');
  assert.ok(!ownerGrant.includes(VAULT_PLAINTEXT_PERMISSION));
});

test('vault rbac: FormulasController.getActualFormula — denied for owner (full grant, minus the one permission that matters)', () => {
  const ownerPrincipal = principal({ roles: ['owner'], permissions: ownerGrant });
  assertForbidden(() => guard.canActivate(fakeContext(FormulasController, 'getActualFormula', ownerPrincipal)));
});

/* ── super_admin denied: the blanket bypass never covers formula:actual:read (§107/§109) ───── */

test('vault rbac: FormulasController.getActualFormula — denied for super_admin holding zero permissions', () => {
  const superAdmin = principal({ roles: ['super_admin'], permissions: [] });
  assertForbidden(() => guard.canActivate(fakeContext(FormulasController, 'getActualFormula', superAdmin)));
});

test('vault rbac: super_admin STILL bypasses an ordinary (non-vault) permission — the short-circuit is narrowed, not removed', () => {
  const superAdmin = principal({ roles: ['super_admin'], permissions: [] });
  // formula:formula_master:read is an ordinary structural read, not the plaintext gate.
  assert.equal(guard.canActivate(fakeContext(FormulasController, 'listFormulas', superAdmin)), true);
});

test('vault rbac: FormulasController.verifyAuditChain — denied for super_admin (also gated by formula:actual:read)', () => {
  const superAdmin = principal({ roles: ['super_admin'], permissions: [] });
  assertForbidden(() => guard.canActivate(fakeContext(FormulasController, 'verifyAuditChain', superAdmin)));
});

// Documents the scope of the narrowing on purpose: approve/reject are Vault-authority DECISIONS
// (§107/§108), not the plaintext-read permission itself — `formula:formula_approval:write` is
// an ORDINARY permission the guard still lets super_admin bypass. The SoD check in
// ApprovalsService (author != approver) and @FreshAuth() are what actually protect approve/
// reject; this guard only ever protected the plaintext gate.
test('vault rbac: super_admin still bypasses approve/reject at the guard layer — only formula:actual:read is fail-closed there', () => {
  const superAdmin = principal({ roles: ['super_admin'], permissions: [] });
  assert.equal(guard.canActivate(fakeContext(ApprovalsController, 'approveVersion', superAdmin)), true);
  assert.equal(guard.canActivate(fakeContext(ApprovalsController, 'rejectVersion', superAdmin)), true);
});
