/**
 * OPS_GREEN §17 (P1 poison event), RawProd's half. Real Postgres, the real signed
 * ImporterService path and the real BridgeRelayService with a stubbed transport.
 *
 *   inbound   a malformed event (unparseable/missing needed_by, unknown type) is a 400 with
 *             `permanent: true` and a machine-readable code, and records nothing; a database
 *             fault is a 503 `permanent: false`, a data fault a 400 `permanent: true`; a
 *             duplicate is a harmless 200 `already_seen`.
 *   outbound  ALEMBIC refusing an event as permanent parks it after ONE attempt (audited, listed,
 *             never re-sent); a transient failure backs off and parks only at the ceiling; a later
 *             event for the aggregate is held behind a parked one; replay and discard work and
 *             are audited; a repeat is 409, never a second effect.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { ConflictException } from '@nestjs/common';
import { ImporterService } from '../bridge/importer.service.js';
import { BridgeRelayService } from '../bridge/relay.service.js';
import { OutboxAdminService } from '../bridge/outbox-admin.service.js';
import { sealSecret } from '../bridge/secret-box.js';
import { signBody, verifyBody } from '../bridge/signing.js';
import {
  validateInboundPayload, decideFailedDelivery, classifyDeliveryFailure, BRIDGE_MAX_DELIVERY_ATTEMPTS,
} from '../bridge/contract.js';
import { ensureSchema, bridgeDb, testClient, closeTestClient } from '../../../test-support/db.js';

const SECRET = 'bridge-poison-test-secret';
const WEBHOOK = 'https://alembic.example.test/api/v1/bridge/rawprod/webhooks/in';
let importer: ImporterService;
let relay: BridgeRelayService;
let admin: OutboxAdminService;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  const sql = testClient();
  await sql`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
            values ('default', true, ${WEBHOOK}, ${sealSecret(SECRET)})
            on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url,
                                           hmac_secret_sealed = excluded.hmac_secret_sealed`;
  importer = new ImporterService(bridgeDb(), sql);
  relay = new BridgeRelayService(bridgeDb());
  admin = new OutboxAdminService(bridgeDb());
});

after(async () => { relay?.onModuleDestroy(); await closeTestClient(); });

function created(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  const reqId = randomUUID();
  return {
    event_id: randomUUID(), version: 1, type: 'ProductionRequirementCreated',
    org_id: randomUUID(), correlation_id: randomUUID(), causation_id: null,
    occurred_at: new Date().toISOString(), source: 'alembic',
    aggregate: { type: 'production_requirement', id: reqId },
    payload: {
      requirement_id: reqId, order_ref: 'SO-POISON', mapped_sku: 'FSKU-POISON', qty: '10', uom: 'kg',
      pack_size: null, needed_by: '2026-10-01T00:00:00.000Z', priority: 'normal', ...payload,
    },
    ...overrides,
  };
}

function send(env: unknown, svc: ImporterService = importer) {
  const body = JSON.stringify(env);
  return svc.handleAlembicEvent(body, signBody(body, SECRET));
}

async function inboundCount(eventId: string): Promise<number> {
  const r = await testClient()`select count(*)::int as n from bridge.inbound_event where event_id = ${eventId}`;
  return r[0]!.n as number;
}

/* ── pure ─────────────────────────────────────────────────────────────── */

test('payload contract: every field the importer reads is checked, per type', () => {
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', created().payload), []);
  const { needed_by: _drop, ...noNeededBy } = created().payload;
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', noNeededBy), ['needed_by:missing']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', created({}, { needed_by: 'soon' }).payload),
    ['needed_by:invalid']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', created({}, { qty: '-3', priority: 'asap' }).payload),
    ['qty:invalid', 'priority:invalid']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', { needed_by: 'x' }), ['needed_by:invalid']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', {}), []);
  assert.deepEqual(validateInboundPayload('ProductionRequirementFulfilled', { uom: 'kg' }), ['received_qty:missing']);
});

test('delivery policy mirrors ALEMBIC: permanent parks at once, transient backs off to a ceiling', () => {
  assert.equal(classifyDeliveryFailure({ status: 400, body: { permanent: true } }), 'permanent');
  assert.equal(classifyDeliveryFailure({ status: 401 }), 'transient');
  assert.equal(classifyDeliveryFailure({ status: 503 }), 'transient');
  assert.equal(classifyDeliveryFailure({}), 'transient');
  assert.deepEqual(decideFailedDelivery({ status: 422 }, 0), { failureClass: 'permanent', park: 'permanent', retryInSeconds: null });
  assert.equal(decideFailedDelivery({ status: 503 }, 0).retryInSeconds, 2);
  assert.equal(decideFailedDelivery({ status: 503 }, BRIDGE_MAX_DELIVERY_ATTEMPTS - 1).park, 'max_attempts');
});

/* ── inbound ──────────────────────────────────────────────────────────── */

test('inbound: an unparseable needed_by is a 400 permanent refusal, not a 500, and records nothing', async () => {
  const env = created({}, { needed_by: 'next tuesday' });
  const r = await send(env);
  assert.equal(r.status, 400);
  assert.equal(r.body.permanent, true);
  assert.equal(r.body.code, 'BRIDGE_PERMANENT_INVALID_PAYLOAD');
  assert.equal(r.body.detail, 'needed_by:invalid');
  assert.equal(await inboundCount(env.event_id), 0);

  const { needed_by: _drop, ...rest } = env.payload;
  const missing = await send({ ...env, event_id: randomUUID(), payload: rest });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.detail, 'needed_by:missing');
});

test('inbound: an unknown event type is a 400 permanent refusal with its own code', async () => {
  const r = await send(created({ type: 'SomethingNobodyEmits' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.permanent, true);
  assert.equal(r.body.code, 'BRIDGE_PERMANENT_UNKNOWN_TYPE');
});

test('inbound: a bad signature is 401 and explicitly NOT permanent (a configuration fault)', async () => {
  const body = JSON.stringify(created());
  const r = await importer.handleAlembicEvent(body, signBody(body, 'some-other-secret'));
  assert.equal(r.status, 401);
  assert.equal(r.body.permanent, false);
});

test('inbound: a database fault is a 503 transient; a data fault is a 400 permanent; nothing half-applies', async () => {
  const failing = (code: string) => (() => { throw Object.assign(new Error(`simulated ${code}`), { code }); }) as unknown as Sql;
  const env = created();
  const transient = await send(env, new ImporterService(bridgeDb(), failing('08006')));
  assert.equal(transient.status, 503);
  assert.equal(transient.body.permanent, false);
  assert.equal(transient.body.code, 'BRIDGE_TRANSIENT');
  assert.equal(await inboundCount(env.event_id), 0, 'the dedupe row rolled back with the failed apply');

  const env2 = created();
  const data = await send(env2, new ImporterService(bridgeDb(), failing('22007')));
  assert.equal(data.status, 400);
  assert.equal(data.body.permanent, true);
  assert.equal(data.body.code, 'BRIDGE_PERMANENT_UNAPPLIABLE');

  // The transient one, retried once the fault clears, applies normally.
  const retried = await send(env);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.outcome, 'applied');
});

test('inbound: a duplicate delivery is harmless -- 200 already_seen, applied once', async () => {
  const env = created();
  assert.equal((await send(env)).body.outcome, 'applied');
  const again = await send(env);
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, 'already_seen');
  const reqs = await testClient()`select count(*)::int as n from bridge.production_requirement
                                   where alembic_requirement_id = ${env.aggregate.id}`;
  assert.equal(reqs[0]!.n, 1);
});

/* ── outbound ─────────────────────────────────────────────────────────── */

async function queueOutbox(type = 'ProductionScheduled', aggregateId: string = randomUUID()): Promise<string> {
  const r = await testClient()`insert into bridge.outbox (type, aggregate_id, payload)
    values (${type}, ${aggregateId}, ${JSON.stringify({ requirement_id: aggregateId, _bridge_version: 2 })}::jsonb)
    returning id`;
  return r[0]!.id as string;
}

async function delivery(id: string) {
  const r = await testClient()`select d.attempts, d.parked_at, d.parked_reason, d.last_error, d.last_http_status,
                                      d.next_attempt_at > now() as backed_off, d.discarded_at, d.discard_reason,
                                      o.published_at
                                 from bridge.outbox o left join bridge.outbox_delivery d on d.outbox_id = o.id
                                where o.id = ${id}`;
  return r[0]!;
}

async function audits(id: string): Promise<string[]> {
  const r = await testClient()`select action from bridge.audit_events where entity_id = ${id} order by occurred_at, id`;
  return r.map((x) => x.action as string);
}

/** Scripted ALEMBIC: `script` answers for the ids a test owns; anything else (other test files'
 *  leftovers in this shared DB) is accepted so it cannot perturb the assertions. */
function alembic(script: Map<string, () => Response>, calls: string[] = []) {
  relay.fetchImpl = async (_url, init) => {
    const body = String(init?.body ?? '');
    const sig = (init?.headers as Record<string, string>)['x-bridge-signature'];
    assert.ok(verifyBody(body, SECRET, sig), 'every delivery is signed');
    const id = JSON.parse(body).event_id as string;
    calls.push(id);
    const answer = script.get(id);
    return answer ? answer() : new Response('{"outcome":"applied"}', { status: 200 });
  };
  return calls;
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

test('outbound: ALEMBIC refusing an event as permanent parks it after ONE attempt, audited, never re-sent', async () => {
  const id = await queueOutbox('SalesOrderManualContinuityCreated');
  const calls = alembic(new Map([[id, json(400, { outcome: 'bad_envelope', permanent: true, code: 'BRIDGE_PERMANENT_UNKNOWN_TYPE' })]]));
  await relay.drain();
  let d = await delivery(id);
  assert.equal(d.attempts, 1);
  assert.equal(d.parked_reason, 'permanent');
  assert.equal(d.last_http_status, 400);
  assert.equal(d.last_error, 'http_400: BRIDGE_PERMANENT_UNKNOWN_TYPE');
  assert.equal(d.published_at, null);
  assert.deepEqual(await audits(id), ['bridge.outbox_parked']);

  await testClient()`update bridge.outbox_delivery set next_attempt_at = now() - interval '1 hour' where outbox_id = ${id}`;
  await relay.drain();
  assert.equal(calls.filter((c) => c === id).length, 1, 'a parked poison event is never re-sent');
  d = await delivery(id);
  assert.equal(d.attempts, 1);

  const listed = (await admin.listParked()).items.find((x) => x.id === id);
  assert.ok(listed);
  assert.equal(listed.parkedReason, 'permanent');
  assert.equal((listed as unknown as Record<string, unknown>).payload, undefined);
});

test('outbound: a transient failure backs off (no 2-second hammering) and parks only at the ceiling', async () => {
  const id = await queueOutbox();
  const calls = alembic(new Map([[id, json(503, { outcome: 'transient_error', permanent: false })]]));
  await relay.drain();
  let d = await delivery(id);
  assert.equal(d.attempts, 1);
  assert.equal(d.parked_at, null);
  assert.equal(d.backed_off, true);
  await relay.drain();
  assert.equal(calls.filter((c) => c === id).length, 1, 'not due again until its backoff passes');

  await testClient()`update bridge.outbox_delivery set attempts = ${BRIDGE_MAX_DELIVERY_ATTEMPTS - 1}, next_attempt_at = now()
                      where outbox_id = ${id}`;
  await relay.drain();
  d = await delivery(id);
  assert.equal(d.attempts, BRIDGE_MAX_DELIVERY_ATTEMPTS);
  assert.equal(d.parked_reason, 'max_attempts');
});

test('outbound: a later event for an aggregate is held behind its parked predecessor', async () => {
  const agg = randomUUID();
  const first = await queueOutbox('ProductionScheduled', agg);
  const calls = alembic(new Map([[first, json(422, {})]]));
  await relay.drain();
  assert.equal((await delivery(first)).parked_reason, 'permanent');
  const second = await queueOutbox('ProductionStarted', agg);
  await relay.drain();
  assert.equal(calls.includes(second), false, 'v2 must wait for v1');
  assert.equal((await delivery(second)).published_at, null);
});

test('outbound: replay re-sends with a fresh budget (duplicate harmless); discard is final; both audited, repeats 409', async () => {
  const replayId = await queueOutbox();
  const discardId = await queueOutbox();
  const refuse = json(400, { permanent: true, code: 'BRIDGE_PERMANENT_INVALID_ENVELOPE' });
  alembic(new Map([[replayId, refuse], [discardId, refuse]]));
  await relay.drain();
  assert.equal((await delivery(replayId)).parked_reason, 'permanent');
  assert.equal((await delivery(discardId)).parked_reason, 'permanent');

  const actor = randomUUID();
  const rp = await admin.replay(replayId, actor);
  assert.equal(rp.replayed, true);
  assert.equal(rp.prior.parkedReason, 'permanent');
  const after = await delivery(replayId);
  assert.equal(after.parked_at, null);
  assert.equal(after.attempts, 0);
  await assert.rejects(admin.replay(replayId, actor), ConflictException, 'a second replay is refused, not re-applied');

  // ALEMBIC already has it: answers already_seen (200) -> published, the duplicate is harmless.
  const calls = alembic(new Map([[replayId, json(200, { outcome: 'already_seen' })]]));
  await relay.drain();
  assert.ok(calls.includes(replayId));
  assert.equal(calls.includes(discardId), false, 'the other event is still parked');
  assert.ok((await delivery(replayId)).published_at);
  assert.deepEqual(await audits(replayId), ['bridge.outbox_parked', 'bridge.outbox_replayed']);

  const dc = await admin.discard(discardId, actor, 'ALEMBIC does not accept this type yet');
  assert.equal(dc.discarded, true);
  const d = await delivery(discardId);
  assert.ok(d.discarded_at);
  assert.equal(d.discard_reason, 'ALEMBIC does not accept this type yet');
  assert.equal((await admin.listParked()).items.some((x) => x.id === discardId), false);
  await assert.rejects(admin.replay(discardId, actor), ConflictException);
  await assert.rejects(admin.discard(discardId, actor, 'again'), ConflictException);
  assert.deepEqual(await audits(discardId), ['bridge.outbox_parked', 'bridge.outbox_discarded']);
});
