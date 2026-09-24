/**
 * PB-03 remainder — `InternalBridgeGuard` unit tests, same fake-`ExecutionContext` pattern
 * `fresh-auth.guard.test.ts` uses (no Nest DI container, no network, no DB).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '../../config/config.service.js';
import { DomainError } from '../domain-error.js';
import { InternalBridgeGuard } from '../internal-bridge.guard.js';
import { computeInternalBridgeSignature } from '../internal-bridge-signing.js';

const KEY = 'a-shared-secret-distributed-via-ssm';

function config(overrides: Record<string, string> = {}) {
  return new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vonly_test',
    JWT_SECRET: 'x'.repeat(32),
    ...overrides,
  });
}

function fakeContext(req: { method?: string; url?: string; headers: Record<string, string>; rawBody?: string }) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

function assertUnauthorized(fn: () => unknown, messagePattern?: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof DomainError);
    assert.equal((err as DomainError).status, 401);
    assert.equal((err as DomainError).code, 'INTERNAL_BRIDGE_UNAUTHORIZED');
    if (messagePattern) assert.match((err as DomainError).message, messagePattern);
    return true;
  });
}

test('refuses closed when INTERNAL_BRIDGE_KEY is not configured', () => {
  const guard = new InternalBridgeGuard(config());
  assertUnauthorized(
    () => guard.canActivate(fakeContext({ headers: {} })),
    /not configured/,
  );
});

test('refuses when the signature/timestamp headers are missing', () => {
  const guard = new InternalBridgeGuard(config({ INTERNAL_BRIDGE_KEY: KEY }));
  assertUnauthorized(() => guard.canActivate(fakeContext({ headers: {} })), /Missing/);
});

test('accepts a correctly signed request', () => {
  const guard = new InternalBridgeGuard(config({ INTERNAL_BRIDGE_KEY: KEY }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{"materialIds":["m-1"]}';
  const path = '/internal/vault-bridge/material-aliases-batch';
  const signature = computeInternalBridgeSignature(KEY, { method: 'POST', path, body, timestamp });

  const ok = guard.canActivate(
    fakeContext({
      method: 'POST',
      url: path,
      rawBody: body,
      headers: { 'x-internal-signature': signature, 'x-internal-timestamp': timestamp },
    }),
  );
  assert.equal(ok, true);
});

test('refuses a request signed with a different key', () => {
  const guard = new InternalBridgeGuard(config({ INTERNAL_BRIDGE_KEY: KEY }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const path = '/internal/vault/resolve-manufacturing-instruction';
  const signature = computeInternalBridgeSignature('wrong-key', { method: 'POST', path, body: '', timestamp });

  assertUnauthorized(() =>
    guard.canActivate(
      fakeContext({
        method: 'POST',
        url: path,
        rawBody: '',
        headers: { 'x-internal-signature': signature, 'x-internal-timestamp': timestamp },
      }),
    ),
  );
});

test('refuses a request whose rawBody was tampered with after signing', () => {
  const guard = new InternalBridgeGuard(config({ INTERNAL_BRIDGE_KEY: KEY }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const path = '/internal/vault/resolve-manufacturing-instruction';
  const signedBody = '{"formulaVersionId":"fv-1","permittedBatchQuantity":1}';
  const signature = computeInternalBridgeSignature(KEY, { method: 'POST', path, body: signedBody, timestamp });

  assertUnauthorized(() =>
    guard.canActivate(
      fakeContext({
        method: 'POST',
        url: path,
        rawBody: signedBody.replace('1}', '999999}'),
        headers: { 'x-internal-signature': signature, 'x-internal-timestamp': timestamp },
      }),
    ),
  );
});

test('L1: refuses a replayed (reused) signature within the window', () => {
  const guard = new InternalBridgeGuard(config({ INTERNAL_BRIDGE_KEY: KEY }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{"replay":true}';
  const path = '/internal/vault/resolve-manufacturing-instruction';
  const signature = computeInternalBridgeSignature(KEY, { method: 'POST', path, body, timestamp });
  const req = () => fakeContext({
    method: 'POST', url: path, rawBody: body,
    headers: { 'x-internal-signature': signature, 'x-internal-timestamp': timestamp },
  });
  assert.equal(guard.canActivate(req()), true);
  assertUnauthorized(() => guard.canActivate(req()), /Replayed/);
});

test('L1: INTERNAL_BRIDGE_KEY shorter than 32 chars is rejected by the config schema', () => {
  assert.throws(() => config({ INTERNAL_BRIDGE_KEY: 'short-key' }));
  assert.doesNotThrow(() => config({ INTERNAL_BRIDGE_KEY: 'k'.repeat(32) }));
});
