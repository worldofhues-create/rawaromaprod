/**
 * S3 security review item 2 — `FreshAuthGuard` must measure staleness off `principal.authTime`
 * (when the credential was actually PROVED), never `principal.iat` (when this particular
 * access token happened to be minted) — a session refreshed minutes ago must not read as
 * "freshly authenticated" just because its token is new. Real `Reflector` + a real
 * `@FreshAuth()`-decorated test class, same pattern `vault-rbac.test.ts` uses for
 * `PermissionsGuard`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { FreshAuth } from '../../decorators/fresh-auth.decorator.js';
import { FreshAuthGuard } from '../fresh-auth.guard.js';
import { DomainError } from '../domain-error.js';
import { principal } from '../../../../test-support/db.js';

class VaultLikeController {
  @FreshAuth(300)
  decrypt(): void {}

  unmarked(): void {}
}

const reflector = new Reflector();
const guard = new FreshAuthGuard(reflector);

function fakeContext(methodName: keyof VaultLikeController, user: unknown) {
  const handler = (VaultLikeController.prototype as any)[methodName];
  return {
    getHandler: () => handler,
    getClass: () => VaultLikeController,
    switchToHttp: () => ({ getRequest: () => ({ user, url: '/vault/decrypt' }) }),
  } as any;
}

function assertStepUpRequired(fn: () => unknown) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).status, 403);
    assert.equal((err as DomainError).code, 'AUTH_STEP_UP_REQUIRED');
    return true;
  });
}

test('a session whose authTime is within the window passes', () => {
  const p = principal({ authTime: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(guard.canActivate(fakeContext('decrypt', p)), true);
});

test('a session whose authTime is OLDER than the window is refused, even with a brand-new iat '
  + '(the exact bug this review item closes: a refreshed token must not read as fresh)', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const p = principal({
    iat: nowSec, // freshly re-minted by a refresh...
    authTime: nowSec - 3600, // ...but the underlying credential was proved an hour ago
  });
  assertStepUpRequired(() => guard.canActivate(fakeContext('decrypt', p)));
});

test('a session whose iat is OLD but authTime is fresh (a real stepped-up assertion carried '
  + 'through unchanged) passes — proves the guard reads authTime, not iat, in the other '
  + 'direction too', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const p = principal({ iat: nowSec - 3600, authTime: nowSec - 5 });
  assert.equal(guard.canActivate(fakeContext('decrypt', p)), true);
});

test('an unmarked route (no @FreshAuth) is unaffected regardless of staleness', () => {
  const p = principal({ authTime: Math.floor(Date.now() / 1000) - 999_999 });
  assert.equal(guard.canActivate(fakeContext('unmarked', p)), true);
});

test('no principal at all on a @FreshAuth route fails closed with AUTH_TOKEN_INVALID', () => {
  assert.throws(() => guard.canActivate(fakeContext('decrypt', undefined)), (err: unknown) => {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).code, 'AUTH_TOKEN_INVALID');
    return true;
  });
});
