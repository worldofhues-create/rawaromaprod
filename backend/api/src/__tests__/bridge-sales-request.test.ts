/**
 * SALES-REQUEST-BRIDGE (docs/bridge/EVENT_CONTRACT.md, "Sales requests"): ALEMBIC records a
 * production request an agent raises from an enquiry or a customer BEFORE any order exists, and
 * sends it on the existing ProductionRequirementCreated / Changed / Cancelled with
 * `origin: "sales_request"` and `request_ref` in place of `order_ref` / `order_refs`.
 *
 * Pinned here, pure and against real Postgres through the real signed ImporterService:
 *   - a sales request with request_ref and no order_ref is valid; one that also carries an
 *     order_ref / order_refs is refused (it would tell the Factory an order exists);
 *   - origin: "sales_request" without request_ref is refused, permanently;
 *   - an unknown origin is refused;
 *   - an ORDER requirement (no origin) is validated exactly as before;
 *   - applied, the row records origin + request_ref, order_ref stays empty, the existing
 *     Accepted / RejectedMapping / CancelledAck answers are unchanged;
 *   - the arrival alert never calls it an order;
 *   - `production_requirement_status` by order number never answers with a sales request.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ImporterService } from '../bridge/importer.service.js';
import { sealSecret } from '../bridge/secret-box.js';
import { signBody } from '../bridge/signing.js';
import { validateInboundPayload, normalizeRequirementPayload } from '../bridge/contract.js';
import { FactsService } from '../facts/facts.service.js';
import { ensureSchema, bridgeDb, testClient, closeTestClient } from '../../../test-support/db.js';

const SECRET = 'bridge-sales-request-test-secret';
const WEBHOOK = 'https://alembic.example.test/api/v1/bridge/rawprod/webhooks/in';
let importer: ImporterService;
let factorySku = '';

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  const sql = testClient();
  await sql`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
            values ('default', true, ${WEBHOOK}, ${sealSecret(SECRET)})
            on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url,
                                           hmac_secret_sealed = excluded.hmac_secret_sealed`;
  const productId = randomUUID();
  const code = `SREQ-${productId.slice(0, 8)}`;
  factorySku = `${code}-1KG`;
  await sql`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
            values (${productId}, ${randomUUID()}, ${code}, 'Sales request product', 'ACTIVE')`;
  await sql`insert into packaging.product_sku (product_id, sku_code, status) values (${productId}, ${factorySku}, 'ACTIVE')`;
  importer = new ImporterService(bridgeDb(), sql);
});

after(async () => { await closeTestClient(); });

function salesPayload(reqId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirement_id: reqId, origin: 'sales_request', request_ref: reqId, enquiry_code: 'ENQ-0042',
    mapped_sku: factorySku, sku: 'RAC-ISO-E-SUPER', qty: '2500000', uom: 'mg', qty_kg: '2.500',
    pack_size: '1 kg', needed_by: '2020-01-01T00:00:00.000Z', priority: 'normal', lot_policy: 'fifo', ...over,
  };
}

function envelope(type: string, reqId: string, payload: Record<string, unknown>, version = 1, corr = randomUUID()) {
  return {
    event_id: randomUUID(), version, type, org_id: randomUUID(), correlation_id: corr, causation_id: null,
    occurred_at: new Date().toISOString(), source: 'alembic',
    aggregate: { type: 'production_requirement', id: reqId }, payload,
  };
}

function send(env: unknown) {
  const body = JSON.stringify(env);
  return importer.handleAlembicEvent(body, signBody(body, SECRET));
}

/* ── pure ─────────────────────────────────────────────────────────────── */

test('contract: a sales request carries request_ref in place of order_ref', () => {
  const id = randomUUID();
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', salesPayload(id)), []);
  const { request_ref: _r, ...noRef } = salesPayload(id);
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', noRef), ['request_ref:missing']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', salesPayload(id, { request_ref: 'x'.repeat(101) })),
    ['request_ref:invalid']);
  /* An order reference on a sales request would tell the Factory an order exists. */
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', salesPayload(id, { order_ref: 'SO-1' })),
    ['order_ref:invalid']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', salesPayload(id, { order_refs: ['SO-1'] })),
    ['order_refs:invalid']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', salesPayload(id, { origin: 'forecast' })),
    ['origin:invalid', 'order_ref:missing']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', { origin: 'sales_request', request_ref: id, qty: '10', uom: 'kg' }), []);
  assert.deepEqual(validateInboundPayload('ProductionRequirementChanged', { origin: 'sales_request', order_ref: 'SO-1' }), ['order_ref:invalid']);
  assert.deepEqual(validateInboundPayload('ProductionRequirementCancelled', { origin: 'sales_request', request_ref: id, reason: 'no longer wanted' }), []);
});

test('contract: an order requirement (no origin) is validated exactly as before', () => {
  const order = {
    requirement_id: randomUUID(), order_ref: 'SO-1', mapped_sku: 'F', qty: '10', uom: 'kg',
    pack_size: null, needed_by: '2026-10-01T00:00:00.000Z', priority: 'normal',
  };
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', order), []);
  const { order_ref: _o, ...noOrder } = order;
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', noOrder), ['order_ref:missing']);
  /* request_ref alone does not make an order requirement valid: origin says what it is. */
  assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', { ...noOrder, request_ref: 'R' }), ['order_ref:missing']);
  const n = normalizeRequirementPayload(order);
  assert.equal(n.orderRef, 'SO-1');
  assert.equal(n.origin, undefined);
});

test('contract: normalizing a sales request yields origin + request_ref and no order ref', () => {
  const id = randomUUID();
  const n = normalizeRequirementPayload(salesPayload(id));
  assert.equal(n.origin, 'sales_request');
  assert.equal(n.requestRef, id);
  assert.equal(n.orderRef, undefined);
  assert.equal(n.orderRefs, undefined);
});

/* ── real importer ────────────────────────────────────────────────────── */

test('inbound: a sales request is applied, accepted, and never called an order', async () => {
  const sql = testClient();
  const id = randomUUID();
  const res = await send(envelope('ProductionRequirementCreated', id, salesPayload(id)));
  assert.deepEqual(res, { status: 200, body: { outcome: 'applied' } });
  const [row] = await sql`select origin, request_ref, order_ref, order_refs, mapped_sku, lifecycle_status, (qty::numeric)::int::text as qty, uom
                            from bridge.production_requirement where alembic_requirement_id = ${id}`;
  assert.deepEqual({ ...row }, {
    origin: 'sales_request', request_ref: id, order_ref: '', order_refs: null, mapped_sku: factorySku,
    lifecycle_status: 'ACCEPTED', qty: '2500000', uom: 'mg',
  });
  const out = await sql`select type, payload from bridge.outbox where aggregate_id = ${id}`;
  assert.deepEqual(out.map((o) => o.type), ['ProductionRequirementAccepted']);
  /* needed_by is in the past: the overdue alert is raised, and it does not say "order". */
  const alerts = await sql`select kind, title, detail from production.produce_alert where ref_id = ${id}`;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, 'overdue_requirement');
  assert.doesNotMatch(`${alerts[0]!.title} ${alerts[0]!.detail}`, /order/i);
  assert.match(String(alerts[0]!.detail), /sales request/);
});

test('inbound: an unmapped sales request is RejectedMapping, as for an order', async () => {
  const id = randomUUID();
  const res = await send(envelope('ProductionRequirementCreated', id, salesPayload(id, { mapped_sku: 'NO-SUCH-FSKU', needed_by: '2099-01-01' })));
  assert.equal(res.status, 200);
  const out = await testClient()`select type from bridge.outbox where aggregate_id = ${id}`;
  assert.deepEqual(out.map((o) => o.type), ['ProductionRequirementRejectedMapping']);
});

test('inbound: a sales request with no request_ref is a 400 permanent refusal and records nothing', async () => {
  const id = randomUUID();
  const { request_ref: _r, ...p } = salesPayload(id);
  const env = envelope('ProductionRequirementCreated', id, p);
  const res = await send(env);
  assert.equal(res.status, 400);
  assert.equal(res.body.permanent, true);
  assert.equal(res.body.code, 'BRIDGE_PERMANENT_INVALID_PAYLOAD');
  const n = await testClient()`select count(*)::int as n from bridge.inbound_event where event_id = ${env.event_id}`;
  assert.equal(n[0]!.n, 0);
});

test('inbound: a sales request is changed and cancelled; the CancelledAck answer is unchanged', async () => {
  const sql = testClient();
  const id = randomUUID();
  const corr = randomUUID();
  await send(envelope('ProductionRequirementCreated', id, salesPayload(id, { needed_by: '2099-01-01' }), 1, corr));
  const ch = await send(envelope('ProductionRequirementChanged', id, { requirement_id: id, origin: 'sales_request', request_ref: id, qty: '3000000', uom: 'mg' }, 2, corr));
  assert.deepEqual(ch, { status: 200, body: { outcome: 'applied' } });
  const cx = await send(envelope('ProductionRequirementCancelled', id, { requirement_id: id, origin: 'sales_request', request_ref: id, reason: 'customer withdrew' }, 3, corr));
  assert.deepEqual(cx, { status: 200, body: { outcome: 'applied' } });
  const [row] = await sql`select (qty::numeric)::int::text as qty, lifecycle_status, order_ref, origin from bridge.production_requirement where alembic_requirement_id = ${id}`;
  assert.deepEqual({ ...row }, { qty: '3000000', lifecycle_status: 'CANCELLED', order_ref: '', origin: 'sales_request' });
  const out = await sql`select type from bridge.outbox where aggregate_id = ${id}`;
  assert.deepEqual(out.map((o) => o.type).sort(), ['ProductionRequirementAccepted', 'ProductionRequirementCancelledAck']);
});

test('inbound: an order requirement still records origin "order" and its order_ref', async () => {
  const id = randomUUID();
  const ref = `SO-SREQ-${id.slice(0, 6)}`;
  const res = await send(envelope('ProductionRequirementCreated', id, {
    requirement_id: id, order_ref: ref, mapped_sku: factorySku, qty: '10', uom: 'kg', pack_size: null,
    needed_by: '2099-01-01T00:00:00.000Z', priority: 'normal',
  }));
  assert.deepEqual(res, { status: 200, body: { outcome: 'applied' } });
  const [row] = await testClient()`select origin, request_ref, order_ref, order_refs from bridge.production_requirement where alembic_requirement_id = ${id}`;
  assert.deepEqual({ ...row }, { origin: 'order', request_ref: null, order_ref: ref, order_refs: [ref] });
});

test('facts: production_requirement_status by order number never answers with a sales request', async () => {
  const facts = new FactsService(testClient(), bridgeDb());
  const id = randomUUID();
  await send(envelope('ProductionRequirementCreated', id, salesPayload(id, { needed_by: '2099-01-01' })));
  assert.equal(await facts.resolve('production_requirement_status', { orderRef: id }), null);
  assert.equal(await facts.resolve('production_requirement_status', { orderRef: '' }), null);
});
