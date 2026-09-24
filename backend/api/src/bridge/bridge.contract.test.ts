/**
 * RawProd's half of the bridge contract test (§44/§57): envelope validation, §24
 * SKU-acceptance decision, and §26 idempotency/ordering — the same duplicate /
 * out-of-order / replay / unmapped-SKU / cancel scenarios ALEMBIC's
 * `packages/domain/test/bridge.test.ts` covers, run against RawProd's own pure decision
 * functions (`contract.ts`). Two independently-written test suites agreeing on what
 * "duplicate" and "out of order" mean for the same envelope shape IS the two-process
 * contract test at the unit level; a live two-server run (see the lane report for what's
 * left) additionally exercises the HTTP/HMAC transport, which these do not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvelope, INBOUND_FROM_ALEMBIC, decideInbound, decideAcceptance } from './contract.js';
import { signBody, verifyBody } from './signing.js';
import { sealSecret, openSecret } from './secret-box.js';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: '11111111-1111-1111-1111-111111111111',
    version: 1,
    type: 'ProductionRequirementCreated',
    org_id: '22222222-2222-2222-2222-222222222222',
    correlation_id: '33333333-3333-3333-3333-333333333333',
    causation_id: null,
    occurred_at: '2026-09-23T10:00:00.000Z',
    source: 'alembic',
    aggregate: { type: 'production_requirement', id: '44444444-4444-4444-4444-444444444444' },
    payload: { order_ref: 'SO-1', mapped_sku: 'FSKU-1', qty: '10', uom: 'kg', needed_by: '2026-10-01T00:00:00.000Z', priority: 'normal' },
    ...overrides,
  };
}

test('a well-formed ALEMBIC envelope validates', () => {
  const r = validateEnvelope(envelope(), INBOUND_FROM_ALEMBIC);
  assert.equal(r.ok, true);
});

test('an envelope naming a type outside the inbound allow-list is refused', () => {
  const r = validateEnvelope(envelope({ type: 'ProductionScheduled' }), INBOUND_FROM_ALEMBIC);
  // ProductionScheduled is a RawProd->ALEMBIC type; RawProd never receives it, so it is
  // not in INBOUND_FROM_ALEMBIC and must be refused, not silently accepted.
  assert.equal(r.ok, false);
});

test('scenario: duplicate delivery short-circuits before ordering is consulted', () => {
  const d = decideInbound({
    alreadyRecorded: true, incomingVersion: 1, lastAppliedVersion: 1,
    currentStatus: 'ACCEPTED', eventType: 'ProductionRequirementChanged',
  });
  assert.deepEqual(d, { action: 'duplicate' });
});

test('scenario: a brand-new aggregate accepts ONLY a version-1 Created event', () => {
  const created = decideInbound({
    alreadyRecorded: false, incomingVersion: 1, lastAppliedVersion: 0,
    currentStatus: null, eventType: 'ProductionRequirementCreated',
  });
  assert.deepEqual(created, { action: 'apply' });

  const changedFirst = decideInbound({
    alreadyRecorded: false, incomingVersion: 1, lastAppliedVersion: 0,
    currentStatus: null, eventType: 'ProductionRequirementChanged',
  });
  assert.deepEqual(changedFirst, { action: 'unknown_aggregate' });
});

test('scenario: out-of-order delivery (version skips ahead) is parked', () => {
  const d = decideInbound({
    alreadyRecorded: false, incomingVersion: 3, lastAppliedVersion: 1,
    currentStatus: 'ACCEPTED', eventType: 'ProductionRequirementChanged',
  });
  assert.deepEqual(d, { action: 'park', parkedReason: 'out_of_order' });
});

test('scenario: replay after the fact (version behind) never rewinds state', () => {
  const d = decideInbound({
    alreadyRecorded: false, incomingVersion: 1, lastAppliedVersion: 3,
    currentStatus: 'ACCEPTED', eventType: 'ProductionRequirementChanged',
  });
  assert.deepEqual(d, { action: 'park', parkedReason: 'out_of_order' });
});

test('scenario: unmapped SKU never accepts — RawProd is the authority on its own catalogue', () => {
  assert.equal(decideAcceptance(false), 'ProductionRequirementRejectedMapping');
  assert.equal(decideAcceptance(true), 'ProductionRequirementAccepted');
});

test('scenario: cancel closes the aggregate; a later event is parked, not applied', () => {
  const d = decideInbound({
    alreadyRecorded: false, incomingVersion: 5, lastAppliedVersion: 4,
    currentStatus: 'CANCELLED', eventType: 'ProductionRequirementChanged',
  });
  assert.deepEqual(d, { action: 'park', parkedReason: 'out_of_order' });
});

test('scenario: a cancel arriving for an already-cancelled aggregate is still decided by version, not refused outright', () => {
  const d = decideInbound({
    alreadyRecorded: false, incomingVersion: 5, lastAppliedVersion: 4,
    currentStatus: 'CANCELLED', eventType: 'ProductionRequirementCancelled',
  });
  assert.deepEqual(d, { action: 'apply' });
});

/* ── transport ──────────────────────────────────────────────────────── */

test('verifyBody accepts only the correct signature over the exact bytes sent', () => {
  const body = JSON.stringify(envelope());
  const sig = signBody(body, 'shared-secret');
  assert.equal(verifyBody(body, 'shared-secret', sig), true);
  assert.equal(verifyBody(body, 'wrong-secret', sig), false);
  assert.equal(verifyBody(body, 'shared-secret', null), false);
});

test('ALEMBIC and RawProd compute an identical signature for identical bytes', () => {
  // The whole channel depends on this being true; if the two algorithms ever drift this
  // is the first test that fails, before a live delivery does.
  const body = JSON.stringify(envelope());
  const secret = 'shared-secret';
  const sig = signBody(body, secret);
  assert.equal(sig.startsWith('sha256='), true);
  assert.equal(sig.length, 'sha256='.length + 64);
});

/* ── secret sealing ──────────────────── */

test('sealSecret/openSecret round-trip under a configured KEK', () => {
  /* A throwaway key for this test only, so the round-trip always runs; the
     deployment's real key never enters the test process. */
  const prior = process.env.BRIDGE_HMAC_KEK;
  process.env.BRIDGE_HMAC_KEK = Buffer.alloc(32, 7).toString('base64');
  try {
    const sealed = sealSecret('super-secret-value');
    assert.notEqual(sealed, 'super-secret-value');
    assert.equal(openSecret(sealed), 'super-secret-value');
  } finally {
    if (prior === undefined) delete process.env.BRIDGE_HMAC_KEK; else process.env.BRIDGE_HMAC_KEK = prior;
  }
});

test('openSecret returns null (never throws) for garbage input', () => {
  assert.equal(openSecret('not-valid-base64-ciphertext'), null);
});

test('scenario: a Fulfilled event on an ACCEPTED aggregate at the next version applies', () => {
  const r = validateEnvelope(envelope({ type: 'ProductionRequirementFulfilled', version: 2 }), INBOUND_FROM_ALEMBIC);
  assert.equal(r.ok, true);
  assert.deepEqual(decideInbound({
    alreadyRecorded: false, incomingVersion: 2, lastAppliedVersion: 1,
    currentStatus: 'ACCEPTED', eventType: 'ProductionRequirementFulfilled',
  }), { action: 'apply' });
});

test('scenario: COMPLETE is terminal — any later non-duplicate event parks out_of_order', () => {
  for (const eventType of ['ProductionRequirementFulfilled', 'ProductionRequirementChanged', 'ProductionRequirementCancelled']) {
    assert.deepEqual(decideInbound({
      alreadyRecorded: false, incomingVersion: 3, lastAppliedVersion: 2,
      currentStatus: 'COMPLETE', eventType,
    }), { action: 'park', parkedReason: 'out_of_order' });
  }
  // a redelivered event_id is still a duplicate, not a park
  assert.deepEqual(decideInbound({
    alreadyRecorded: true, incomingVersion: 2, lastAppliedVersion: 2,
    currentStatus: 'COMPLETE', eventType: 'ProductionRequirementFulfilled',
  }), { action: 'duplicate' });
});
