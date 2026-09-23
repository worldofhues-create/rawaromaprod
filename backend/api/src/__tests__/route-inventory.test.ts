/**
 * route-inventory.test.ts — the build-time half of the guard fail-closed fix (Lane GUARD
 * security review: `PermissionsGuard` used to let any authenticated route with no
 * `@Permissions` decorator through unconditionally). `permissions-guard.test.ts` proves the
 * GUARD denies an unmarked route at runtime; this test proves the INVENTORY of real routes has
 * no unmarked one to begin with, so a newly added route without a decision fails CI the moment
 * it's written rather than waiting to be hit by a real request in production.
 *
 * Every `backend/**​/*.controller.ts` is walked (the same `walkControllers` shape
 * `rbac-negative-matrix.test.ts` uses) and every method is checked for Nest's OWN
 * `PATH_METADATA` — the metadata `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` set on a method,
 * regardless of what that method is named or how it's exported. That's how a real route
 * handler is told apart from an ordinary prototype method (a private helper, a getter target)
 * without hand-maintaining a second list of routes that could drift from the real ones.
 *
 * A route counts as having a decision when it carries a real (non-empty) `@Permissions(...)`,
 * `@Public()`, `@SelfService()`, `@DynamicPermission(reason)`, or `@AnyAuthenticated(reason)` --
 * read via the same `Reflector`/metadata keys `PermissionsGuard` itself reads at runtime, not a
 * re-parsed copy of the decorator source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import {
  META_ANY_AUTHENTICATED,
  META_DYNAMIC_PERMISSION,
  META_PERMISSIONS,
  META_PUBLIC,
  META_SELF_SERVICE,
} from '../../../backend-kernel/src/decorators/metadata.keys.js';

const reflector = new Reflector();

function walkControllers(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkControllers(full, out);
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const repoRoot = process.cwd(); // run-tests.mjs spawns `node --test` with cwd: repoRoot
const controllerFiles = walkControllers(join(repoRoot, 'backend')).sort();

interface RouteEntry {
  label: string;
  hasDecision: boolean;
}

const routes: RouteEntry[] = [];

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

      // PATH_METADATA is set ONLY by an HTTP method decorator (@Get/@Post/@Put/@Patch/@Delete/
      // ...) -- a plain prototype method never carries it, so this is how a real route handler
      // is told apart from everything else that might live on a controller class.
      const httpPath = reflector.getAllAndOverride<string>(PATH_METADATA, [fn, exported]);
      if (httpPath === undefined) continue;

      const requiredPermissions = reflector.getAllAndOverride<string[]>(META_PERMISSIONS, [
        fn,
        exported,
      ]);
      const isPublic = reflector.getAllAndOverride<boolean>(META_PUBLIC, [fn, exported]);
      const isSelfService = reflector.getAllAndOverride<boolean>(META_SELF_SERVICE, [
        fn,
        exported,
      ]);
      const dynamicReason = reflector.getAllAndOverride<string>(META_DYNAMIC_PERMISSION, [
        fn,
        exported,
      ]);
      const anyAuthReason = reflector.getAllAndOverride<string>(META_ANY_AUTHENTICATED, [
        fn,
        exported,
      ]);

      const hasDecision = Boolean(
        (requiredPermissions && requiredPermissions.length > 0)
          || isPublic
          || isSelfService
          || dynamicReason
          || anyAuthReason,
      );

      routes.push({
        label: `${file.replace(`${repoRoot}/`, '')}: ${exportName}.${method}`,
        hasDecision,
      });

      // @DynamicPermission / @AnyAuthenticated exist to document a VERIFIED exception, not to
      // be reached for as a blind escape hatch -- both require a real, non-empty reason string
      // so an empty `@DynamicPermission('')` can't slip through as "documented."
      if (dynamicReason !== undefined) {
        assert.ok(
          dynamicReason.trim().length > 0,
          `${exportName}.${method}: @DynamicPermission needs a real reason, not an empty string`,
        );
      }
      if (anyAuthReason !== undefined) {
        assert.ok(
          anyAuthReason.trim().length > 0,
          `${exportName}.${method}: @AnyAuthenticated needs a real reason, not an empty string`,
        );
      }
    }
  }
}

test('route inventory: the controller walk actually reached a realistic number of files', () => {
  assert.ok(
    controllerFiles.length >= 50,
    `only found ${controllerFiles.length} *.controller.ts files -- the walk has stopped reaching them`,
  );
});

test('route inventory: the route scan actually reached a realistic number of routes', () => {
  assert.ok(
    routes.length >= 450,
    `only found ${routes.length} route handlers -- PATH_METADATA detection has broken`,
  );
});

for (const { label, hasDecision } of routes) {
  test(`route inventory: ${label} has an explicit access decision`, () => {
    assert.ok(
      hasDecision,
      `${label} has none of @Permissions(...)/@Public()/@SelfService()/@DynamicPermission(reason)/`
        + '@AnyAuthenticated(reason) -- PermissionsGuard denies this route at runtime (fail closed); '
        + 'add one of those decorators, verified against what the service actually does.',
    );
  });
}
