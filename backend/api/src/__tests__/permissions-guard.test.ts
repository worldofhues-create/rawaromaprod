/**
 * RP-FAC — "wrong role" coverage for every controller this lane touched. Rather than duplicating
 * an HTTP-level 403 test per route, this drives the real `PermissionsGuard` (the actual class
 * every route in the app runs behind) against the real `@Permissions(...)` metadata attached to
 * each controller method via `Reflector` — the same mechanism Nest uses at runtime. A principal
 * missing the required permission must be denied; one holding it (or `super_admin`) must pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import {
  AnyAuthenticated,
  DynamicPermission,
  Permissions,
  Public,
  SelfService,
} from '../../../backend-kernel/src/decorators/index.js';
import { BatchController } from '../../../cluster-production/src/batch/batch.controller.js';
import { ReservationController } from '../../../cluster-packaging/src/reservation/reservation.controller.js';
import { DispatchController } from '../../../cluster-sales/src/dispatch/dispatch.controller.js';
import { PackagingQcController } from '../packaging-qc/packaging-qc.controller.js';
import { principal } from '../../../test-support/db.js';

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

const cases: Array<[Function, string, ReturnType<typeof principal>]> = [
  [BatchController, 'transitionOilBatch', principal({ permissions: [] })],
  [ReservationController, 'create', principal({ permissions: [] })],
  [DispatchController, 'createDispatch', principal({ permissions: [] })],
  [PackagingQcController, 'create', principal({ permissions: [] })],
];

for (const [Controller, method, user] of cases) {
  test(`permissions guard: ${Controller.name}.${method} denies a principal with no permissions`, () => {
    assert.throws(() => guard.canActivate(fakeContext(Controller, method, user)), (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 403);
      return true;
    });
  });

  test(`permissions guard: ${Controller.name}.${method} allows a principal holding the required permission`, () => {
    const required: string[] = reflector.getAllAndOverride('core:permissions', [
      (Controller.prototype as any)[method],
      Controller,
    ]);
    const allowed = principal({ permissions: required });
    assert.equal(guard.canActivate(fakeContext(Controller, method, allowed)), true);
  });

  test(`permissions guard: ${Controller.name}.${method} allows super_admin regardless of permissions`, () => {
    const admin = principal({ permissions: [], roles: ['super_admin'] });
    assert.equal(guard.canActivate(fakeContext(Controller, method, admin)), true);
  });
}

test('permissions guard: an unauthenticated request (no principal) is rejected', () => {
  assert.throws(
    () => guard.canActivate(fakeContext(BatchController, 'transitionOilBatch', undefined)),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 401);
      return true;
    },
  );
});

/* ── FAIL CLOSED (security review) ───────────────────────────────────────
 * The guard used to treat "no @Permissions" as "let it through." These prove the fixed
 * behaviour directly against fake controllers carrying each marker (and none), independent of
 * whatever real controllers exist today — route-inventory.test.ts is what proves every REAL
 * route in the app actually carries one of these markers.
 */

class UnmarkedFixture {
  unmarkedRoute() {
    return null;
  }
}

class PublicFixture {
  @Public()
  publicRoute() {
    return null;
  }
}

class SelfServiceFixture {
  @SelfService()
  selfRoute() {
    return null;
  }
}

class DynamicPermissionFixture {
  @DynamicPermission('fixture: service checks this itself')
  dynamicRoute() {
    return null;
  }
}

class AnyAuthenticatedFixture {
  @AnyAuthenticated('fixture: self-masks instead of denying')
  anyAuthRoute() {
    return null;
  }
}

class StaticPermissionFixture {
  @Permissions('masterdata:material:read')
  staticRoute() {
    return null;
  }
}

test('permissions guard (fail closed): a route with NO decorator at all is denied for an authenticated principal', () => {
  const user = principal({ permissions: [] });
  assert.throws(
    () => guard.canActivate(fakeContext(UnmarkedFixture, 'unmarkedRoute', user)),
    (err: unknown) => {
      assert.ok(err instanceof DomainError, `expected a DomainError, got ${String(err)}`);
      assert.equal((err as DomainError).status, 403, 'an unmarked route must 403, never pass through');
      return true;
    },
  );
});

test('permissions guard (fail closed): a route with NO decorator at all is denied (401) with no principal either', () => {
  assert.throws(
    () => guard.canActivate(fakeContext(UnmarkedFixture, 'unmarkedRoute', undefined)),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 401);
      return true;
    },
  );
});

test('permissions guard (fail closed): @Public() still bypasses everything, even with no principal at all', () => {
  assert.equal(guard.canActivate(fakeContext(PublicFixture, 'publicRoute', undefined)), true);
});

test('permissions guard (fail closed): @SelfService() is accepted as the access decision for an authenticated principal holding no permissions', () => {
  const user = principal({ permissions: [] });
  assert.equal(guard.canActivate(fakeContext(SelfServiceFixture, 'selfRoute', user)), true);
});

test('permissions guard (fail closed): @SelfService() still requires authentication', () => {
  assert.throws(
    () => guard.canActivate(fakeContext(SelfServiceFixture, 'selfRoute', undefined)),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 401);
      return true;
    },
  );
});

test('permissions guard (fail closed): @DynamicPermission(reason) is accepted as the access decision -- the SERVICE, not this guard, enforces the real permission', () => {
  const user = principal({ permissions: [] });
  assert.equal(guard.canActivate(fakeContext(DynamicPermissionFixture, 'dynamicRoute', user)), true);
});

test('permissions guard (fail closed): @AnyAuthenticated(reason) is accepted as the access decision for any authenticated principal', () => {
  const user = principal({ permissions: [] });
  assert.equal(guard.canActivate(fakeContext(AnyAuthenticatedFixture, 'anyAuthRoute', user)), true);
});

test('permissions guard (fail closed): a real @Permissions(...) route is unaffected by the fail-closed change', () => {
  assert.throws(
    () => guard.canActivate(fakeContext(StaticPermissionFixture, 'staticRoute', principal({ permissions: [] }))),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal((err as DomainError).status, 403);
      return true;
    },
  );
  const allowed = principal({ permissions: ['masterdata:material:read'] });
  assert.equal(guard.canActivate(fakeContext(StaticPermissionFixture, 'staticRoute', allowed)), true);
});
