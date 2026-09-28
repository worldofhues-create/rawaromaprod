/**
 * Compliance documents — permissions (owner rulings 2026-09-28). Drives the REAL PermissionsGuard
 * against the REAL @Permissions/@FreshAuth metadata on CoaController (factory QC) and
 * ComplianceController (Vault), with the REAL seeded role grants (scripts/ra-roles.ts over
 * scripts/ra-permissions.ts), same shape as vault-rbac.test.ts / production-role.test.ts:
 *
 *   - Vault compliance data and the calculation are formulator / vault_approver only: never the
 *     owner's blanket grant, never super_admin's bypass (`vault:` is never implicit), no factory role.
 *   - The preview and missing-data report decrypt formulas → also need a fresh sign-in.
 *   - Factory QC: the `qc` role keeps specs, records and releases COAs; `production` reads only;
 *     release is its own permission (a principal that may record may not necessarily release).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { META_FRESH_AUTH } from '../../../backend-kernel/src/decorators/metadata.keys.js';
import { CoaController } from '../../../cluster-production/src/coa/coa.controller.js';
import { ComplianceController } from '../../../cluster-formula/src/compliance/compliance.controller.js';
import { principal } from '../../../test-support/db.js';
import { ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const reflector = new Reflector();
const guard = new PermissionsGuard(reflector);

function ctx(Controller: Function, method: string, user: unknown) {
  const handler = (Controller.prototype as Record<string, unknown>)[method];
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
}
function allowed(Controller: Function, method: string, user: unknown): boolean {
  try {
    return guard.canActivate(ctx(Controller, method, user)) === true;
  } catch (err) {
    assert.ok(err instanceof DomainError && err.status === 403, `unexpected error ${String(err)}`);
    return false;
  }
}
const grant = (code: string) => RA_PERMISSIONS.filter((p) => ROLES.find((r) => r.code === code)!.select(p));
const as = (code: string) => principal({ roles: [code], permissions: grant(code) });

const VAULT_METHODS = ['settings', 'updateSettings', 'allergenRefs', 'materials', 'material', 'saveMaterial', 'import', 'status', 'recalculate', 'preview', 'missing'];
const VAULT_WRITES = ['updateSettings', 'saveMaterial', 'import', 'recalculate'];

test('every new permission is in the catalogue the seed grants from', () => {
  for (const p of [
    'production:product_qc_spec:read', 'production:product_qc_spec:write', 'production:batch_coa:read',
    'production:batch_coa:write', 'production:batch_coa:release',
    'vault:rm_compliance:read', 'vault:rm_compliance:write', 'vault:compliance_calc:read',
  ]) assert.ok(RA_PERMISSIONS.includes(p), p);
});

test('Vault compliance: formulator and vault_approver hold every route', () => {
  for (const role of ['formulator', 'vault_approver']) {
    for (const m of VAULT_METHODS) assert.equal(allowed(ComplianceController, m, as(role)), true, `${role} → ${m}`);
  }
});

test('Vault compliance: owner (full grant), super_admin (bypass), and every factory role are refused', () => {
  const superAdmin = principal({ roles: ['super_admin'], permissions: [] });
  for (const m of VAULT_METHODS) {
    assert.equal(allowed(ComplianceController, m, as('owner')), false, `owner → ${m}`);
    assert.equal(allowed(ComplianceController, m, superAdmin), false, `super_admin → ${m}`);
    for (const role of ['admin', 'qc', 'production', 'compounding', 'packaging', 'showcase']) {
      assert.equal(allowed(ComplianceController, m, as(role)), false, `${role} → ${m}`);
    }
  }
});

test('Vault compliance: read-only holders cannot write; preview/missing need the calc permission', () => {
  const reader = principal({ roles: ['x'], permissions: ['vault:rm_compliance:read'] });
  for (const m of VAULT_WRITES) assert.equal(allowed(ComplianceController, m, reader), false, m);
  assert.equal(allowed(ComplianceController, 'materials', reader), true);
  assert.equal(allowed(ComplianceController, 'preview', reader), false);
  assert.equal(allowed(ComplianceController, 'missing', reader), false);
});

test('Vault compliance: the preview and missing-data report demand a fresh sign-in (they decrypt formulas)', () => {
  for (const m of ['preview', 'missing']) {
    const maxAge = reflector.get<number | undefined>(META_FRESH_AUTH, (ComplianceController.prototype as unknown as Record<string, Function>)[m]!);
    assert.ok(typeof maxAge === 'number' && maxAge > 0, m);
  }
});

test('factory QC: the qc role keeps specs, records and releases COAs', () => {
  for (const m of ['listSpecs', 'getSpec', 'upsertSpec', 'list', 'get', 'candidateProducts', 'record', 'release']) {
    assert.equal(allowed(CoaController, m, as('qc')), true, `qc → ${m}`);
  }
});

test('factory QC: production oversight reads only; floor roles see nothing; release is separate from record', () => {
  for (const m of ['listSpecs', 'list', 'get']) assert.equal(allowed(CoaController, m, as('production')), true, m);
  for (const m of ['upsertSpec', 'record', 'release']) assert.equal(allowed(CoaController, m, as('production')), false, m);
  for (const role of ['compounding', 'filling', 'receiving', 'formulator']) {
    for (const m of ['record', 'release', 'upsertSpec']) assert.equal(allowed(CoaController, m, as(role)), false, `${role} → ${m}`);
  }
  const recorder = principal({ roles: ['x'], permissions: ['production:batch_coa:write', 'production:batch_coa:read'] });
  assert.equal(allowed(CoaController, 'record', recorder), true);
  assert.equal(allowed(CoaController, 'release', recorder), false);
});
