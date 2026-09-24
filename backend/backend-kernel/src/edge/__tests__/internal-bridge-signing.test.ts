/**
 * PB-03 remainder — pure unit tests for the internal bridge's signing primitive (no Nest, no
 * network, no DB): the same shape `alembic-assertion.test.ts`-style files in this repo use for
 * a hand-written crypto verifier. `internal-bridge.guard.test.ts` covers the NestJS guard built
 * on top of this.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeInternalBridgeSignature,
  verifyInternalBridgeSignature,
  type InternalBridgeSignInput,
} from '../internal-bridge-signing.js';

const KEY = 'a-shared-secret-distributed-via-ssm';

function input(overrides: Partial<InternalBridgeSignInput> = {}): InternalBridgeSignInput {
  return {
    method: 'POST',
    path: '/internal/vault/resolve-manufacturing-instruction',
    body: '{"formulaVersionId":"fv-1","permittedBatchQuantity":10}',
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
}

test('a signature computed with the right key verifies', () => {
  const i = input();
  const sig = computeInternalBridgeSignature(KEY, i);
  assert.equal(verifyInternalBridgeSignature(KEY, i, sig), true);
});

test('method is case-insensitive at signing time (normalized to uppercase)', () => {
  const sig = computeInternalBridgeSignature(KEY, input({ method: 'post' }));
  assert.equal(verifyInternalBridgeSignature(KEY, input({ method: 'POST' }), sig), true);
});

test('a signature computed with the WRONG key does not verify', () => {
  const i = input();
  const sig = computeInternalBridgeSignature('a-different-secret', i);
  assert.equal(verifyInternalBridgeSignature(KEY, i, sig), false);
});

test('tampering with the body invalidates the signature', () => {
  const i = input();
  const sig = computeInternalBridgeSignature(KEY, i);
  const tampered = { ...i, body: i.body.replace('10', '10000') };
  assert.equal(verifyInternalBridgeSignature(KEY, tampered, sig), false);
});

test('tampering with the path invalidates the signature', () => {
  const i = input();
  const sig = computeInternalBridgeSignature(KEY, i);
  const tampered = { ...i, path: '/internal/vault/resolve-manufacturing-instruction-evil' };
  assert.equal(verifyInternalBridgeSignature(KEY, tampered, sig), false);
});

test('a signature older than the clock-skew window is refused (replay protection)', () => {
  const i = input({ timestamp: String(Math.floor(Date.now() / 1000) - 3600) }); // 1h old
  const sig = computeInternalBridgeSignature(KEY, i);
  assert.equal(verifyInternalBridgeSignature(KEY, i, sig), false);
});

test('a signature just inside the clock-skew window still verifies', () => {
  const i = input({ timestamp: String(Math.floor(Date.now() / 1000) - 30) }); // 30s old
  const sig = computeInternalBridgeSignature(KEY, i);
  assert.equal(verifyInternalBridgeSignature(KEY, i, sig), true);
});

test('a non-numeric timestamp never verifies', () => {
  const i = input({ timestamp: 'not-a-number' });
  const sig = computeInternalBridgeSignature(KEY, i);
  assert.equal(verifyInternalBridgeSignature(KEY, i, sig), false);
});

test('a body-less GET (empty body string) signs and verifies', () => {
  const i = input({ method: 'GET', path: '/internal/vault-bridge/material-search?q=lav&limit=10', body: '' });
  const sig = computeInternalBridgeSignature(KEY, i);
  assert.equal(verifyInternalBridgeSignature(KEY, i, sig), true);
});
