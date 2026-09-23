/**
 * RP-IDENT — the `production` role (owner override 2026-09-21: ERP_BOUNDARY lifted,
 * manufacturing/QC is in scope). Before this role existed, `production:production_plan:write`,
 * `production:production_plan_items:write`, `production:production_order:write` and
 * `production:material_pick_list:write` sat with `owner` only — no operational role could plan or
 * schedule a production run. This proves, against the SAME `PermissionsGuard` +
 * `@Permissions(...)` metadata every route in the app runs behind (the pattern
 * permissions-guard.test.ts established), that:
 *   1. the production role's real, computed permission grant (scripts/ra-roles.ts `select()`) now
 *      passes the guard on the planning/pick-list write routes that used to be owner-only;
 *   2. it is still refused on every floor-EXECUTION write (secure mixing, material issue,
 *      production QC result entry, CAPA) and on the Formula Vault boundary — those stay with the
 *      role that actually performs them (compounding / qc), per the masking model documented in
 *      ra-roles.ts;
 *   3. the two seed-time HARD INVARIANTS (only `formulator`/`vault_approver` hold
 *      `formula:actual:read` — NOT `owner`, per §107's "no implicit vault plaintext"; only
 *      `owner`+`admin` may hold the role-grant permission) still hold for every role, including
 *      the new one;
 *   4. the two-console gate (auth.service.ts `FACTORY_ONLY_ROLES`) treats `production` as a
 *      factory-floor role, matching every other floor role.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { PlanningController } from '../../../cluster-production/src/planning/planning.controller.js';
import { PickingController } from '../../../cluster-production/src/picking/picking.controller.js';
import { MixingController } from '../../../cluster-production/src/mixing/mixing.controller.js';
import { BatchController } from '../../../cluster-production/src/batch/batch.controller.js';
import { CapaController } from '../../../cluster-quality/src/capa/capa.controller.js';
import { principal } from '../../../test-support/db.js';
import {
  ROLES,
  VAULT_PLAINTEXT_PERMISSION,
  VAULT_PLAINTEXT_ROLES,
  ROLE_GRANT_PERMISSION,
  ROLE_GRANTERS,
} from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..', '..');

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

function requiredPerms(Controller: Function, method: string): string[] {
  return reflector.getAllAndOverride('core:permissions', [
    (Controller.prototype as any)[method],
    Controller,
  ]);
}

const productionRole = ROLES.find((r) => r.code === 'production');

test('production role: exists in the seed catalog', () => {
  assert.ok(productionRole, 'scripts/ra-roles.ts must define a `production` RoleDef');
});

const productionGrant = RA_PERMISSIONS.filter((p) => productionRole!.select(p));
const productionPrincipal = principal({ roles: ['production'], permissions: productionGrant });

/* ── 1. previously owner-only planning/pick-list writes now pass for `production` ────────── */

const NOW_GRANTED: Array<[Function, string]> = [
  [PlanningController, 'createPlan'],
  [PlanningController, 'createPlanItem'],
  [PlanningController, 'createOrder'],
  [PickingController, 'generatePickList'],
];

for (const [Controller, method] of NOW_GRANTED) {
  test(`production role: ${Controller.name}.${method} — required perm is in the grant, guard allows`, () => {
    const required = requiredPerms(Controller, method);
    for (const p of required) {
      assert.ok(
        productionGrant.includes(p),
        `production role must hold '${p}' (${Controller.name}.${method}) — this was the owner-only gap the role closes`,
      );
    }
    assert.equal(guard.canActivate(fakeContext(Controller, method, productionPrincipal)), true);
  });
}

/* ── 2. floor-execution writes stay refused for `production` (compounding/qc execute them) ── */

const STILL_REFUSED: Array<[Function, string]> = [
  [MixingController, 'startSession'],
  [MixingController, 'logStep'],
  [MixingController, 'endSession'],
  [MixingController, 'abortSession'],
  [BatchController, 'recordProductionQc'],
  [CapaController, 'createCapa'],
  [CapaController, 'startCapa'],
  [CapaController, 'closeCapa'],
  [CapaController, 'verifyCapa'],
];

for (const [Controller, method] of STILL_REFUSED) {
  test(`production role: ${Controller.name}.${method} — still refused (floor execution, not planning)`, () => {
    assert.throws(
      () => guard.canActivate(fakeContext(Controller, method, productionPrincipal)),
      (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal((err as DomainError).status, 403);
        return true;
      },
      `${Controller.name}.${method} must require a permission the production role does not hold`,
    );
  });
}

test('production role: never holds masterdata:material:reveal (stays alias-masked, like compounding/filling)', () => {
  assert.ok(!productionGrant.includes('masterdata:material:reveal'));
});

/* ── 3. seed-time hard invariants still hold for EVERY role including the new one ──────────── */

test('seed invariant: only formulator/vault_approver hold formula:actual:read — owner included in the exclusion (§107, recheck with `production` in the catalog)', () => {
  for (const role of ROLES) {
    const granted = RA_PERMISSIONS.filter((p) => role.select(p));
    if (VAULT_PLAINTEXT_ROLES.includes(role.code)) continue;
    assert.ok(
      !granted.includes(VAULT_PLAINTEXT_PERMISSION),
      `role '${role.code}' must not hold ${VAULT_PLAINTEXT_PERMISSION} — Vault authority is a separate grant (§107)`,
    );
  }
});

test('seed invariant: `owner` specifically does NOT hold formula:actual:read (§107 — the directive change this lane makes)', () => {
  const owner = ROLES.find((r) => r.code === 'owner');
  assert.ok(owner);
  assert.equal(owner!.select(VAULT_PLAINTEXT_PERMISSION), false);
});

test('seed invariant: role-granting stays owner+admin only (recheck with `production` in the catalog)', () => {
  for (const role of ROLES) {
    const granted = RA_PERMISSIONS.filter((p) => role.select(p));
    if (ROLE_GRANTERS.includes(role.code)) continue;
    assert.ok(
      !granted.includes(ROLE_GRANT_PERMISSION),
      `role '${role.code}' must not hold ${ROLE_GRANT_PERMISSION} — only an admin can give the role`,
    );
  }
});

test('production role: does not hold iam:* (cannot manage users/roles/orgs)', () => {
  assert.ok(!productionGrant.some((p) => p.startsWith('iam:')));
});

test('production role: does not hold procurement:*/sales:* (out of manufacturing/QC scope)', () => {
  assert.ok(!productionGrant.some((p) => p.startsWith('procurement:') || p.startsWith('sales:')));
});

/* ── 4. two-console gate treats `production` as a factory-floor role ───────────────────────── */

test('two-console gate: `production` is listed in FACTORY_ONLY_ROLES (auth.service.ts)', () => {
  const src = readFileSync(join(repoRoot, 'backend/cluster-org/src/auth/auth.service.ts'), 'utf8');
  const m = src.match(/const FACTORY_ONLY_ROLES = \[([^\]]+)\];/);
  assert.ok(m, 'FACTORY_ONLY_ROLES array must be present');
  const roles = (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean);
  assert.ok(roles.includes('production'), 'production must be a factory-only console role');
  assert.ok(!roles.includes('owner') && !roles.includes('admin'), 'governance roles stay cross-console, not floor-only');
});

/* ── UI: the portal's ROLES table must expose a nav for `production`, else a logged-in principal
   with this role sees an empty shell (server enforcement is necessary but not sufficient — the
   UI must actually show what the role may do). ─────────────────────────────────────────────── */

test('UI: web/app.js ROLES catalog defines a `production` entry with a non-empty nav', () => {
  const src = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  const idx = src.indexOf('production: { label:');
  assert.ok(idx >= 0, 'web/app.js ROLES must define a `production:` portal entry');
  const closeIdx = src.indexOf('\n    warehouse: {', idx);
  const block = src.slice(idx, closeIdx > 0 ? closeIdx : idx + 2000);
  assert.match(block, /'\/v1\/production-plans'/);
  assert.match(block, /'\/v1\/production-orders'/);
  assert.match(block, /'\/v1\/material-pick-lists'/);
});

/* ── static list-of-test-files sanity, mirrors the harness's own file-discovery so this file is
   never silently skipped ──────────────────────────────────────────────────────────────────── */
test('sanity: this test file is discoverable by the repo test runner (backend/**/*.test.ts)', () => {
  function collect(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) collect(full, out);
      else if (entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }
  const files = collect(join(repoRoot, 'backend'));
  assert.ok(files.some((f) => f.endsWith('production-role.test.ts')));
});
