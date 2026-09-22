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
