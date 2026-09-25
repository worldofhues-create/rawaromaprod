/**
 * material-ref.ts — the keyed material reference the Vault and the main box agree on without the
 * material_id (or an alias) ever crossing the wire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { materialRef, materialRefKey } from '../material-ref.js';

const BRIDGE_KEY = `material-ref-test-${'k'.repeat(32)}`;

test('deterministic for one key and one material; different materials differ', () => {
  const key = materialRefKey(BRIDGE_KEY);
  const m = randomUUID();
  assert.equal(materialRef(key, m), materialRef(materialRefKey(BRIDGE_KEY), m));
  assert.notEqual(materialRef(key, m), materialRef(key, randomUUID()));
  assert.match(materialRef(key, m), /^[A-Za-z0-9_-]{43}$/);
});

test('any spelling of the same uuid agrees (case, surrounding whitespace)', () => {
  const key = materialRefKey(BRIDGE_KEY);
  const m = randomUUID();
  assert.equal(materialRef(key, m.toUpperCase()), materialRef(key, m));
  assert.equal(materialRef(key, ` ${m} `), materialRef(key, m));
});

test('another bridge key gives unrelated references; the ref key is not the bridge key itself', () => {
  const m = randomUUID();
  assert.notEqual(materialRef(materialRefKey(BRIDGE_KEY), m), materialRef(materialRefKey(`${BRIDGE_KEY}x`), m));
  // Purpose-separated: HMAC(bridgeKey, material_id) (what a request signature's key would give) is not the ref.
  assert.notEqual(materialRef(materialRefKey(BRIDGE_KEY), m), createHmac('sha256', BRIDGE_KEY).update(m).digest('base64url'));
});

test('the reference does not contain the material id', () => {
  const m = randomUUID();
  const ref = materialRef(materialRefKey(BRIDGE_KEY), m);
  assert.ok(!ref.includes(m) && !ref.includes(m.replace(/-/g, '')));
});

test('no key, no reference', () => {
  assert.throws(() => materialRefKey(''), /INTERNAL_BRIDGE_KEY/);
});
