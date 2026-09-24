/** L1 — InternalBridgeReplayCache: reuse refused within the window, expiry, bounded (fail closed). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalBridgeReplayCache, INTERNAL_BRIDGE_CLOCK_SKEW_S } from '../internal-bridge-signing.js';

test('first use accepted, reuse within the window refused', () => {
  const c = new InternalBridgeReplayCache();
  const t = 1_000_000;
  assert.equal(c.checkAndRecord('sig-a', t), true);
  assert.equal(c.checkAndRecord('sig-a', t + 1000), false);
  assert.equal(c.checkAndRecord('sig-b', t + 1000), true);
});

test('entries expire after 2x the skew window (the span a signature can still verify)', () => {
  const c = new InternalBridgeReplayCache();
  const t = 1_000_000;
  const retention = 2 * INTERNAL_BRIDGE_CLOCK_SKEW_S * 1000;
  assert.equal(c.checkAndRecord('sig', t), true);
  assert.equal(c.checkAndRecord('sig', t + retention - 1), false);
  assert.equal(c.checkAndRecord('sig', t + retention + 1), true);
});

test('bounded: fails closed when full of live entries, recovers after expiry', () => {
  const c = new InternalBridgeReplayCache(2, 1000);
  assert.equal(c.checkAndRecord('a', 0), true);
  assert.equal(c.checkAndRecord('b', 0), true);
  assert.equal(c.checkAndRecord('c', 10), false);
  assert.equal(c.size, 2);
  assert.equal(c.checkAndRecord('c', 2000), true);
  assert.equal(c.size, 1);
});
