/**
 * Golden-journey gap 3 — factory completion for bridge requirements. ALEMBIC's goods
 * receipt (ProductionRequirementFulfilled) closes a bridge requirement WITHOUT any RawProd
 * sales order: requirement -> COMPLETE, active FG reservations for the linked production
 * order -> HANDED_OVER (+ consumption row), and ProductionRequirementCompleted emitted
 * exactly once. Real Postgres + the real signed ImporterService path.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ImporterService } from '../bridge/importer.service.js';
import { sealSecret } from '../bridge/secret-box.js';
import { signBody } from '../bridge/signing.js';
import { ensureSchema, bridgeDb, testClient, closeTestClient } from '../../../test-support/db.js';

const SECRET = 'bridge-fulfilled-test-secret';
let importer: ImporterService;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  const sql = testClient();
  await sql`insert into bridge.connector_config (id, enabled, hmac_secret_sealed)
            values ('default', true, ${sealSecret(SECRET)})
            on conflict (id) do update set hmac_secret_sealed = excluded.hmac_secret_sealed`;
  importer = new ImporterService(bridgeDb(), sql);
});

after(async () => { await closeTestClient(); });

function send(env: Record<string, unknown>) {
  const body = JSON.stringify(env);
  return importer.handleAlembicEvent(body, signBody(body, SECRET));
}

function fulfilled(reqId: string, correlationId: string, version: number, eventId = crypto.randomUUID(), receivedQty = '10') {
  return {
    event_id: eventId, version, type: 'ProductionRequirementFulfilled',
    org_id: crypto.randomUUID(), correlation_id: correlationId, causation_id: null,
    occurred_at: new Date().toISOString(), source: 'alembic',
    aggregate: { type: 'production_requirement', id: reqId },
    payload: { requirement_id: reqId, order_ref: 'ORD-GJ3', received_qty: receivedQty, uom: 'kg',
      receipt_ref: 'GRN-GJ3-1', received_at: new Date().toISOString() },
  };
}

async function acceptedRequirement(opts: { withFg: boolean }) {
  const sql = testClient();
  const reqId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  let orderId: string | null = null;
  let reservationId: string | null = null;
  let fgId: string | null = null;
  if (opts.withFg) {
    orderId = crypto.randomUUID();
    const oilId = crypto.randomUUID(); const poId = crypto.randomUUID();
    fgId = crypto.randomUUID(); reservationId = crypto.randomUUID();
    await sql`insert into production.production_order (production_order_id, status) values (${orderId}, 'COMPLETED')`;
    await sql`insert into production.oil_batch_master (oil_batch_id, production_order_id) values (${oilId}, ${orderId})`;
    await sql`insert into packaging.package_order (package_order_id, oil_batch_id) values (${poId}, ${oilId})`;
    await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, package_order_id, produced_qty, status)
              values (${fgId}, ${poId}, 10, 'ACTIVE')`;
    await sql`insert into packaging.finished_good_reservation (finished_good_reservation_id, finished_good_batch_id, reserved_qty, status)
              values (${reservationId}, ${fgId}, 10, 'ACTIVE')`;
  }
  await sql`insert into bridge.production_requirement
    (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by,
     lifecycle_status, production_order_id, last_applied_version, last_emitted_version)
    values (${reqId}, ${crypto.randomUUID()}, ${correlationId}, 'ORD-GJ3', 'SKU-1', 10, 'kg', now(),
     'ACCEPTED', ${orderId}, 1, 4)`;
  return { reqId, correlationId, reservationId, fgId };
}

test('Fulfilled completes the requirement, hands over FG, emits Completed once; dup + second Fulfilled do not re-emit', async () => {
  const sql = testClient();
  const { reqId, correlationId, reservationId, fgId } = await acceptedRequirement({ withFg: true });
  const first = fulfilled(reqId, correlationId, 2);

  assert.equal((await send(first)).body.outcome, 'applied');

  const req = (await sql`select lifecycle_status, status_reason, last_applied_version, last_emitted_version
                           from bridge.production_requirement where alembic_requirement_id = ${reqId}`)[0]!;
  assert.equal(req.lifecycle_status, 'COMPLETE');
  assert.match(String(req.status_reason), /GRN-GJ3-1/);
  assert.equal(Number(req.last_applied_version), 2);
  assert.equal(Number(req.last_emitted_version), 5);

  const res = (await sql`select status, released_dt from packaging.finished_good_reservation
                           where finished_good_reservation_id = ${reservationId}`)[0]!;
  assert.equal(res.status, 'HANDED_OVER');
  assert.ok(res.released_dt);
  const cons = await sql`select consumed_qty, consumed_for_document_id from packaging.finished_goods_batch_consumption
                           where finished_good_batch_id = ${fgId}`;
  assert.equal(cons.length, 1);
  assert.equal(Number(cons[0]!.consumed_qty), 10);
  assert.equal(cons[0]!.consumed_for_document_id, reqId);

  // duplicate event_id -> already_seen
  assert.equal((await send(first)).body.outcome, 'already_seen');
  // a second, different Fulfilled on a COMPLETE requirement parks
  assert.equal((await send(fulfilled(reqId, correlationId, 3))).body.outcome, 'parked_out_of_order');

  const out = await sql`select payload from bridge.outbox
                          where aggregate_id = ${reqId} and type = 'ProductionRequirementCompleted'`;
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.payload, {
    requirement_id: reqId, correlation_id: correlationId, order_ref: 'ORD-GJ3',
    receipt_ref: 'GRN-GJ3-1', _bridge_version: 5,
  });
  assert.equal((await sql`select count(*)::int as n from packaging.finished_goods_batch_consumption
                           where finished_good_batch_id = ${fgId}`)[0]!.n, 1);
});

test('Fulfilled works with no sales order and no linked production order (reason recorded)', async () => {
  const sql = testClient();
  const { reqId, correlationId } = await acceptedRequirement({ withFg: false });
  assert.equal((await send(fulfilled(reqId, correlationId, 2))).body.outcome, 'applied');
  const req = (await sql`select lifecycle_status, status_reason from bridge.production_requirement
                           where alembic_requirement_id = ${reqId}`)[0]!;
  assert.equal(req.lifecycle_status, 'COMPLETE');
  assert.match(String(req.status_reason), /no linked production order/);
  const out = await sql`select 1 from bridge.outbox where aggregate_id = ${reqId} and type = 'ProductionRequirementCompleted'`;
  assert.equal(out.length, 1);
});

test('Fulfilled for an unknown requirement parks unknown_aggregate', async () => {
  const r = await send(fulfilled(crypto.randomUUID(), crypto.randomUUID(), 2));
  assert.equal(r.body.outcome, 'parked_unknown_aggregate');
});

test('M3: a partial receipt consumes only received_qty; remainder stays reserved; replay is a no-op; partials accumulate to COMPLETE', async () => {
  const sql = testClient();
  const { reqId, correlationId, reservationId, fgId } = await acceptedRequirement({ withFg: true });
  const first = fulfilled(reqId, correlationId, 2, crypto.randomUUID(), '4');

  assert.equal((await send(first)).body.outcome, 'applied');
  let res = (await sql`select status, released_dt, reserved_qty from packaging.finished_good_reservation
                         where finished_good_reservation_id = ${reservationId}`)[0]!;
  assert.equal(res.status, 'ACTIVE');
  assert.equal(res.released_dt, null);
  assert.equal(Number(res.reserved_qty), 6);
  let consumed = (await sql`select coalesce(sum(consumed_qty),0)::numeric as n from packaging.finished_goods_batch_consumption
                              where finished_good_batch_id = ${fgId}`)[0]!;
  assert.equal(Number(consumed.n), 4);
  let req = (await sql`select lifecycle_status, last_applied_version from bridge.production_requirement
                         where alembic_requirement_id = ${reqId}`)[0]!;
  assert.notEqual(req.lifecycle_status, 'COMPLETE');
  assert.equal(Number(req.last_applied_version), 2);
  assert.equal((await sql`select 1 from bridge.outbox where aggregate_id = ${reqId}
                          and type = 'ProductionRequirementCompleted'`).length, 0);

  // Replaying the same event id is a no-op (nothing further consumed).
  assert.equal((await send(first)).body.outcome, 'already_seen');
  res = (await sql`select reserved_qty from packaging.finished_good_reservation
                     where finished_good_reservation_id = ${reservationId}`)[0]!;
  assert.equal(Number(res.reserved_qty), 6);

  // Second partial (6) completes it.
  assert.equal((await send(fulfilled(reqId, correlationId, 3, crypto.randomUUID(), '6'))).body.outcome, 'applied');
  res = (await sql`select status, released_dt from packaging.finished_good_reservation
                     where finished_good_reservation_id = ${reservationId}`)[0]!;
  assert.equal(res.status, 'HANDED_OVER');
  assert.ok(res.released_dt);
  consumed = (await sql`select coalesce(sum(consumed_qty),0)::numeric as n from packaging.finished_goods_batch_consumption
                          where finished_good_batch_id = ${fgId}`)[0]!;
  assert.equal(Number(consumed.n), 10);
  req = (await sql`select lifecycle_status from bridge.production_requirement where alembic_requirement_id = ${reqId}`)[0]!;
  assert.equal(req.lifecycle_status, 'COMPLETE');
  assert.equal((await sql`select 1 from bridge.outbox where aggregate_id = ${reqId}
                          and type = 'ProductionRequirementCompleted'`).length, 1);
});

test('M4: a thrown apply leaves no inbound_event row, and the retry of the same event completes', async () => {
  const sql = testClient();
  const { reqId, correlationId, reservationId } = await acceptedRequirement({ withFg: true });
  const ev = fulfilled(reqId, correlationId, 2);
  const target = importer as unknown as { applyFulfilled: (...a: unknown[]) => Promise<void> };
  const original = target.applyFulfilled;
  target.applyFulfilled = async () => { throw new Error('boom mid-apply'); };
  try {
    // OPS_GREEN §17: an unexpected apply fault no longer escapes as a 500; it is a 503 marked
    // transient, so ALEMBIC retries it on backoff (bounded) rather than for ever.
    const r = await send(ev);
    assert.equal(r.status, 503);
    assert.equal(r.body.permanent, false);
  } finally {
    target.applyFulfilled = original;
  }
  assert.equal((await sql`select 1 from bridge.inbound_event where event_id = ${ev.event_id}`).length, 0);

  assert.equal((await send(ev)).body.outcome, 'applied');
  const row = (await sql`select processed_at from bridge.inbound_event where event_id = ${ev.event_id}`)[0]!;
  assert.ok(row.processed_at);
  const res = (await sql`select status from packaging.finished_good_reservation
                           where finished_good_reservation_id = ${reservationId}`)[0]!;
  assert.equal(res.status, 'HANDED_OVER');
});
