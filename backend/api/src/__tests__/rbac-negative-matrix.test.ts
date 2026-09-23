/**
 * SB-03 — the generated RBAC negative matrix, RawProd half (V4 §112, §117).
 * ALEMBIC's half lives at apps/api/test/rbac-negative-matrix.test.ts in that
 * repository, generated the same way: walk the real source, not a
 * hand-copied expectation list.
 *
 * `permissions-guard.test.ts` beside this file proved the SHAPE of this test
 * against four hand-picked controllers ("wrong role" coverage). This file is
 * that same shape made GENERATED and EXHAUSTIVE: every `*.controller.ts`
 * under backend/ is walked, and every method carrying a real `@Permissions`
 * decorator (read off the same `Reflector`/`META_PERMISSIONS` the real
 * `PermissionsGuard` reads at runtime -- not a re-parsed copy of the
 * decorator's source text) gets three table-driven cases:
 *
 *   denied     a principal holding NONE of the required permissions
 *   denied     a principal holding all but one (only when >1 is required --
 *              the "just short" case a zero-permission check cannot catch)
 *   permitted  a principal holding exactly the required permissions
 *
 * plus a fourth for every VAULT-SENSITIVE permission (`vault:*`,
 * `formula:actual:*`): `super_admin` must still be DENIED, because §107/§108
 * is "no role gets Vault plaintext implicitly, super_admin included" and
 * `PermissionsGuard`'s own bypass explicitly carves this out
 * (`isNeverImplicit`). `permissions-guard.test.ts` already asserts
 * super_admin's ordinary bypass; this is the boundary that check does not
 * reach because none of its four hand-picked methods require a vault-
 * sensitive permission.
 *
 * A method with NO `@Permissions` and no `@Public()` is a DIFFERENT bug class
 * -- an unguarded route -- and is exactly what
 * ops/scripts/access-catalog.mjs's RawProd controller scan (ALEMBIC repo,
 * PB-05/§112 UNMAPPED_MUTATING_API_ROUTES/UNMAPPED_READ_API_ROUTES) drives to
 * zero; its documented exemption table names the handful that are dynamic
 * per-:resource permissions instead, and THOSE five methods --
 * EditController.update, GeoController.createRegionType/createRegion/
 * updateRegion, OrgUnitsController.create/update, DispatchDocsController
 * .create, SearchController.search -- get their own negative cases below,
 * driving the SERVICE'S `ForbiddenException` directly, since no static
 * `@Permissions` decorator exists for the Reflector to read.
 *
 * "wrong tenant" is not a case here: `PermissionsGuard` is a role/permission
 * gate with no tenant concept of its own (RawProd is single-tenant per
 * deployment, unlike ALEMBIC) -- tenant-shaped scoping in this codebase is
 * row-level (site/warehouse scope inside each service query), which is what
 * the individual cluster test suites (e.g. stock/reservation) already cover
 * against real rows; duplicating that here with a null `Sql` client is not
 * possible and would not be this test's job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { principal } from '../../../test-support/db.js';

const META_PUBLIC = 'core:public';
const META_PERMISSIONS = 'core:permissions';
const NEVER_IMPLICIT = [/^vault:/, /^formula:actual:/];
const isVaultSensitive = (perm: string) => NEVER_IMPLICIT.some((re) => re.test(perm));

const reflector = new Reflector();
const guard = new PermissionsGuard(reflector);

function fakeContext(ControllerClass: Function, methodName: string, user: unknown) {
  const handler = (ControllerClass.prototype as Record<string, unknown>)[methodName];
  return {
    getHandler: () => handler,
    getClass: () => ControllerClass,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as Parameters<PermissionsGuard['canActivate']>[0];
}

function assertDenied(fn: () => unknown, label: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof DomainError, `${label}: expected a DomainError, got ${String(err)}`);
    assert.equal((err as DomainError).status, 403, `${label}: expected 403`);
    return true;
  });
}

/* ── discover every controller and every `@Permissions`-guarded method ── */

function walkControllers(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkControllers(full, out);
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

interface Case { className: string; Controller: Function; method: string; required: string[] }

const repoRoot = process.cwd(); // run-tests.mjs spawns `node --test` with cwd: repoRoot
const controllerFiles = walkControllers(join(repoRoot, 'backend')).sort();

const cases: Case[] = [];
for (const file of controllerFiles) {
  const mod: Record<string, unknown> = await import(pathToFileURL(file).href);
  for (const [exportName, exported] of Object.entries(mod)) {
    if (typeof exported !== 'function' || !exportName.endsWith('Controller')) continue;
    const proto = (exported as { prototype?: Record<string, unknown> }).prototype;
    if (!proto) continue;
    for (const method of Object.getOwnPropertyNames(proto)) {
      if (method === 'constructor') continue;
      const fn = proto[method];
      if (typeof fn !== 'function') continue;
      const isPublic = reflector.getAllAndOverride<boolean>(META_PUBLIC, [fn, exported]);
      if (isPublic) continue;
      const required = reflector.getAllAndOverride<string[]>(META_PERMISSIONS, [fn, exported]);
      if (!required || required.length === 0) continue;
      cases.push({ className: exportName, Controller: exported, method, required });
    }
  }
}

assert.ok(cases.length >= 100,
  `only found ${cases.length} @Permissions-guarded methods -- the controller scan has stopped reaching them`);

for (const { className, Controller, method, required } of cases) {
  const label = `${className}.${method}`;

  test(`SB-03: ${label} denies a principal holding none of [${required.join(', ')}]`, () => {
    assertDenied(() => guard.canActivate(fakeContext(Controller, method, principal({ permissions: [] }))), label);
  });

  if (required.length > 1) {
    test(`SB-03: ${label} denies a principal missing exactly one of [${required.join(', ')}]`, () => {
      const partial = required.slice(1);
      assertDenied(() => guard.canActivate(fakeContext(Controller, method, principal({ permissions: partial }))), label);
    });
  }

  test(`SB-03: ${label} allows a principal holding exactly [${required.join(', ')}]`, () => {
    const allowed = principal({ permissions: required });
    assert.equal(guard.canActivate(fakeContext(Controller, method, allowed)), true, label);
  });

  const vaultPerms = required.filter(isVaultSensitive);
  if (vaultPerms.length > 0) {
    test(`SB-03: ${label} refuses super_admin -- vault-sensitive permission(s) [${vaultPerms.join(', ')}] are never implicit (§107/§108)`, () => {
      const admin = principal({ permissions: [], roles: ['super_admin'] });
      assertDenied(() => guard.canActivate(fakeContext(Controller, method, admin)), label);
    });
  } else {
    test(`SB-03: ${label} allows super_admin regardless of held permissions`, () => {
      const admin = principal({ permissions: [], roles: ['super_admin'] });
      assert.equal(guard.canActivate(fakeContext(Controller, method, admin)), true, label);
    });
  }
}

/* ── the five dynamic per-:resource permission services ────────────────
 *
 * No static `@Permissions` decorator exists for these -- the permission
 * depends on a route parameter the Reflector cannot see -- so each service's
 * own `ForbiddenException` is driven directly, with `sql: null as never`:
 * every one of these checks the caller's permission BEFORE its first `this
 * .sql` call (read from the source, not assumed), so a denied case never
 * reaches the null client.
 */
import { EditService } from '../edit/edit.service.js';
import { GeoService } from '../geo/geo.service.js';
import { OrgUnitsService } from '../orgunits/orgunits.service.js';
import { DispatchDocsService } from '../dispatchdocs/dispatchdocs.service.js';
import { SearchService } from '../search/search.service.js';

function assertForbidden(fn: () => unknown, label: string) {
  assert.throws(fn, (err: unknown) => {
    const status = (err as { getStatus?: () => number; status?: number }).getStatus?.()
      ?? (err as { status?: number }).status;
    assert.equal(status, 403, `${label}: expected a 403 ForbiddenException, got ${String(err)}`);
    return true;
  });
}

const denied = principal({ permissions: [] });

test('SB-03: EditController.update (materials) denies a principal without masterdata:material:write', async () => {
  const svc = new EditService(null as never);
  await assert.rejects(
    () => svc.update('materials', 'x', { materialName: 'x' }, denied),
    (err: unknown) => { assertForbidden(() => { throw err; }, 'EditService.update'); return true; },
  );
});

test('SB-03: GeoController.createRegionType denies a principal without platform:geo_location_master:write', async () => {
  const svc = new GeoService(null as never);
  await assert.rejects(() => svc.createRegionType({ key: 'x', name: 'x' }, denied),
    (err: unknown) => { assertForbidden(() => { throw err; }, 'GeoService.createRegionType'); return true; });
});

test('SB-03: GeoController.createRegion denies a principal without platform:geo_location_master:write', async () => {
  const svc = new GeoService(null as never);
  await assert.rejects(() => svc.createRegion({ name: 'x' }, denied),
    (err: unknown) => { assertForbidden(() => { throw err; }, 'GeoService.createRegion'); return true; });
});

test('SB-03: GeoController.updateRegion denies a principal without platform:geo_location_master:write', async () => {
  const svc = new GeoService(null as never);
  await assert.rejects(() => svc.updateRegion('x', { name: 'x' }, denied),
    (err: unknown) => { assertForbidden(() => { throw err; }, 'GeoService.updateRegion'); return true; });
});

test('SB-03: OrgUnitsController.create denies a principal without iam:business_unit_master:write', async () => {
  const svc = new OrgUnitsService(null as never);
  await assert.rejects(() => svc.create({ name: 'x' }, denied),
    (err: unknown) => { assertForbidden(() => { throw err; }, 'OrgUnitsService.create'); return true; });
});

test('SB-03: OrgUnitsController.update denies a principal without iam:business_unit_master:write', async () => {
  const svc = new OrgUnitsService(null as never);
  await assert.rejects(() => svc.update('x', { name: 'x' }, denied),
    (err: unknown) => { assertForbidden(() => { throw err; }, 'OrgUnitsService.update'); return true; });
});

test('SB-03: DispatchDocsController.create denies a principal without sales:dispatch_master:write', async () => {
  /* No `@Inject(PG_CLIENT)` here (unlike the other four) -- lane F5 found the
     backing table does not exist anywhere and left both methods throwing
     NotImplementedException; the permission check still runs first (read
     from the source above), so this is still a real negative case. */
  const svc = new DispatchDocsService();
  await assert.rejects(() => svc.create({}, denied),
    (err: unknown) => { assertForbidden(() => { throw err; }, 'DispatchDocsService.create'); return true; });
});

test('SB-03: SearchController.search denies a principal without the searched resource\'s own :read permission', async () => {
  const svc = new SearchService(null as never);
  await assert.rejects(() => svc.search('/v1/permissions', '', 10, denied),
    (err: unknown) => { assertForbidden(() => { throw err; }, 'SearchService.search'); return true; });
});
