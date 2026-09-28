/**
 * COA data from factory QC (owner ruling 2026-09-28, item 1) — real Postgres, the real CoaService,
 * BatchService and BridgeRelayService (stubbed transport only).
 *
 *   gating    no QC spec → refused; a batch with any failed test cannot be released (409) and writes
 *             NOTHING to the bridge outbox; a passed batch is released once — one
 *             `qc.batch.released` row, a repeat release is a no-op, a released COA is immutable.
 *   payload   exactly the contract shape (validated), best-before from the product's shelf life,
 *             photo references, SKU codes; no formula content.
 *   product   batch → order → plan item → formula → product; ambiguity and a foreign product refused.
 *   wire      the relay sends it signed over the exact bytes, as aggregate `qc_batch`, with an org id.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { bridge as contracts } from '@core/contracts';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { CoaService } from '../../../cluster-production/src/coa/coa.service.js';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { BridgeRelayService } from '../bridge/relay.service.js';
import { sealSecret } from '../bridge/secret-box.js';
import { verifyBody } from '../bridge/signing.js';
import { ensureSchema, productionDb, bridgeDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

const SECRET = 'coa-release-test-secret';
const WEBHOOK = 'https://alembic.example.test/api/v1/bridge/rawprod/webhooks/in';
const TENANT = randomUUID();
const qc = principal({ userId: randomUUID(), roles: ['qc'] });

let coa: CoaService;
let batches: BatchService;

before(async () => {
  await ensureSchema();
  coa = new CoaService(productionDb());
  batches = new BatchService(productionDb());
});
after(async () => { await closeTestClient(); });

/** A product made from `formulaId`, with SKUs, and an oil batch produced against an order whose
 *  plan item names that formula. */
async function fixture(opts: { formulaId?: string; productCode?: string; producedDt?: string } = {}) {
  const sql = testClient();
  const formulaId = opts.formulaId ?? randomUUID();
  const productId = randomUUID();
  const productCode = opts.productCode ?? `ALT-${productId.slice(0, 8)}`;
  await sql`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
            values (${productId}, ${formulaId}, ${productCode}, 'Althair', 'ACTIVE')`;
  for (const size of ['25KG', '5KG']) {
    await sql`insert into packaging.product_sku (product_id, sku_code, pack_size, status)
              values (${productId}, ${`${productCode}-${size}`}, ${size}, 'ACTIVE')`;
  }
  const planItemId = randomUUID();
  await sql`insert into production.production_plan_items (production_plan_item_id, formula_id, status) values (${planItemId}, ${formulaId}, 'ACTIVE')`;
  const orderId = randomUUID();
  await sql`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status)
            values (${orderId}, ${planItemId}, 25, 'COMPLETED')`;
  const { batch } = await batches.produceOilBatch(
    { productionOrderId: orderId, batchNumber: `A${productId.slice(0, 6)}`, producedQty: 25, producedDt: opts.producedDt ?? '2026-02-14T08:00:00.000Z' },
    qc,
  );
  return { formulaId, productId, productCode, batch };
}

async function spec(productId: string) {
  await coa.upsertSpec(productId, { sgMin: 0.95, sgMax: 1.5, flashPointMinC: 110, flashPointMaxC: 120, shelfLifeMonths: 24 }, qc);
}

const PASSING = {
  sgResult: 0.995, flashPointResultC: 116, colourAppearance: 'Deep Brown', colourAppearancePass: true,
  odourDescription: 'Warm Spicy Vanilla Fragrance', odourPass: true,
};

async function outboxFor(aggregateId: string) {
  return testClient()`select id, type, payload from bridge.outbox where aggregate_id = ${aggregateId} order by seq`;
}

test('no QC spec for the product → the COA is refused', async () => {
  const f = await fixture();
  await assert.rejects(() => coa.recordCoa({ oilBatchId: f.batch.oilBatchId, ...PASSING, photos: [] }, qc),
    (e: unknown) => e instanceof ConflictException && /no QC specification/.test((e as Error).message));
});

test('a failed test → overall FAIL, release refused with 409, and NOTHING reaches the bridge outbox', async () => {
  const f = await fixture();
  await spec(f.productId);
  const { coa: row, failedTests } = await coa.recordCoa({ oilBatchId: f.batch.oilBatchId, ...PASSING, flashPointResultC: 121.5, photos: [] }, qc);
  assert.equal(row.overallResult, 'FAIL');
  assert.equal(row.flashPointPass, false);
  assert.equal(row.sgPass, true);
  assert.deepEqual(failedTests, ['flash point']);
  await assert.rejects(() => coa.releaseCoa(row.batchCoaId, qc),
    (e: unknown) => e instanceof ConflictException && /failed QC \(flash point\)/.test((e as Error).message));
  assert.equal((await outboxFor(row.batchCoaId)).length, 0);
  const after = await coa.getCoa(row.batchCoaId);
  assert.equal(after!.status, 'TESTED');

  // A failed colour/odour conformance call fails the batch just the same.
  const again = await coa.recordCoa({ oilBatchId: f.batch.oilBatchId, ...PASSING, odourPass: false, photos: [] }, qc);
  assert.equal(again.coa.overallResult, 'FAIL');
  await assert.rejects(() => coa.releaseCoa(row.batchCoaId, qc), ConflictException);
  assert.equal((await outboxFor(row.batchCoaId)).length, 0);
});

test('a passed batch is released once: one qc.batch.released with the contract payload; repeat is a no-op; then immutable', async () => {
  const f = await fixture();
  await spec(f.productId);
  const docId = randomUUID();
  await testClient()`insert into platform.document_master (document_id, file_name, file_path, status)
                     values (${docId}, 'a140226.jpg', 'https://files.example.invalid/a140226.jpg', 'ACTIVE')`;
  const { coa: row } = await coa.recordCoa({
    oilBatchId: f.batch.oilBatchId, ...PASSING,
    photos: [{ documentId: docId, caption: 'Retained sample' }, { url: 'https://files.example.invalid/label.jpg' }],
  }, qc);
  assert.equal(row.overallResult, 'PASS');
  assert.equal(String(row.productionDate).slice(0, 10), '2026-02-14');
  assert.equal(String(row.bestBefore).slice(0, 10), '2028-02-14');

  const first = await coa.releaseCoa(row.batchCoaId, qc);
  assert.equal(first.emitted, true);
  assert.equal(first.coa.status, 'RELEASED');
  const events = await outboxFor(row.batchCoaId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'qc.batch.released');
  // Lane produce: what crosses is the DOCS-001 wire shape ALEMBIC parses
  // (docs/bridge/COMPLIANCE_FACTS.md) — the owner's Althair sample, field for field.
  const payload = events[0]!.payload as contracts.QcBatchReleasedWire;
  assert.deepEqual(contracts.checkQcBatchReleasedWire(payload), []);
  assert.doesNotThrow(() => contracts.assertNoFormulaContent(payload));
  assert.deepEqual({ ...payload, released_at: 'X' }, {
    batch_no: f.batch.batchNumber,
    product_ref: { factory_sku: `${f.productCode}-25KG` },
    status: 'passed',
    results: [
      { key: 'odour', label: 'Odour description', value: 'Warm Spicy Vanilla Fragrance', pass: true },
      { key: 'colour_appearance', label: 'Colour and appearance', value: 'Deep Brown', pass: true },
      { key: 'specific_gravity', label: 'Specific Gravity at 20/4°C', value: '0.995', unit: null, method: null,
        spec: { min: '0.950', max: '1.500' }, pass: true },
      { key: 'flash_point', label: 'Zero Reference Flash Point', value: '116.0', unit: '°C', method: 'Pensky-Martens, closed cup',
        spec: { min: '110.0', max: '120.0' }, pass: true },
    ],
    photos: [
      { url: 'https://files.example.invalid/a140226.jpg', asset_ref: `document:${docId}`, caption: 'Retained sample', result_key: null },
      { url: 'https://files.example.invalid/label.jpg', asset_ref: null, caption: null, result_key: null },
    ],
    production_date: '2026-02-14',
    best_before: '2028-02-14',
    released_at: 'X',
    qc_record_ref: row.batchCoaId,
  });
  assert.ok(!Number.isNaN(Date.parse(payload.released_at)));
  assert.ok(!JSON.stringify(payload).includes(f.formulaId), 'the formula id must never cross the bridge');

  const second = await coa.releaseCoa(row.batchCoaId, qc);
  assert.equal(second.emitted, false);
  assert.equal((await outboxFor(row.batchCoaId)).length, 1);
  await assert.rejects(() => coa.recordCoa({ oilBatchId: f.batch.oilBatchId, ...PASSING, photos: [] }, qc),
    (e: unknown) => e instanceof ConflictException && /already been released/.test((e as Error).message));
});

test('product resolution: one product is implied; two need a choice; a product from another formula is refused', async () => {
  const f = await fixture();
  await spec(f.productId);
  // A second product on the same formula makes the batch ambiguous.
  const other = randomUUID();
  await testClient()`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
                     values (${other}, ${f.formulaId}, ${`TWIN-${other.slice(0, 8)}`}, 'Althair twin', 'ACTIVE')`;
  await assert.rejects(() => coa.recordCoa({ oilBatchId: f.batch.oilBatchId, ...PASSING, photos: [] }, qc), BadRequestException);
  const ok = await coa.recordCoa({ oilBatchId: f.batch.oilBatchId, productId: f.productId, ...PASSING, photos: [] }, qc);
  assert.equal(ok.coa.productId, f.productId);
  const foreign = await fixture();
  await assert.rejects(() => coa.recordCoa({ oilBatchId: f.batch.oilBatchId, productId: foreign.productId, ...PASSING, photos: [] }, qc),
    (e: unknown) => e instanceof ConflictException && /not made from this batch/.test((e as Error).message));
  assert.deepEqual((await coa.productsForBatch(f.batch.oilBatchId)).map((p) => p.product_id).sort(), [f.productId, other].sort());
});

test('a photo must reference an existing document or carry a URL', async () => {
  const f = await fixture();
  await spec(f.productId);
  await assert.rejects(() => coa.recordCoa({ oilBatchId: f.batch.oilBatchId, ...PASSING, photos: [{ documentId: randomUUID() }] }, qc), BadRequestException);
});

test('the relay delivers qc.batch.released signed over the exact bytes, as aggregate qc_batch with the tenant org id', async () => {
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  await testClient()`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
            values ('default', true, ${WEBHOOK}, ${sealSecret(SECRET)})
            on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url,
                                           hmac_secret_sealed = excluded.hmac_secret_sealed`;
  const f = await fixture();
  await spec(f.productId);
  const { coa: row } = await coa.recordCoa({ oilBatchId: f.batch.oilBatchId, ...PASSING, photos: [] }, qc);
  await coa.releaseCoa(row.batchCoaId, qc);
  const [event] = await outboxFor(row.batchCoaId);

  const config = new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/unused', JWT_SECRET: 'x'.repeat(32), ALEMBIC_ASSERTION_TENANT_ID: TENANT,
  });
  const relay = new BridgeRelayService(bridgeDb(), config);
  const sent: { headers: Record<string, string>; body: string }[] = [];
  relay.fetchImpl = async (_url, init) => {
    sent.push({ headers: init!.headers as Record<string, string>, body: String(init!.body) });
    return new Response('{"outcome":"applied"}', { status: 200 });
  };
  // Other suites' leftover queued events drain first; keep draining until ours is delivered.
  for (let i = 0; i < 50 && !sent.some((s) => s.headers['x-bridge-event-id'] === event!.id); i++) await relay.drain();
  relay.onModuleDestroy();

  const ours = sent.find((s) => s.headers['x-bridge-event-id'] === event!.id);
  assert.ok(ours, 'the release was delivered');
  assert.equal(verifyBody(ours.body, SECRET, ours.headers['x-bridge-signature']), true);
  const envelope = JSON.parse(ours.body);
  assert.equal(envelope.type, 'qc.batch.released');
  assert.equal(envelope.source, 'rawprod');
  assert.equal(envelope.version, 1);
  assert.deepEqual(envelope.aggregate, { type: 'qc_batch', id: row.batchCoaId });
  assert.equal(envelope.correlation_id, row.batchCoaId);
  assert.equal(envelope.org_id, TENANT); // no requirement to take it from → the configured tenant
  assert.deepEqual(contracts.checkQcBatchReleasedWire(envelope.payload), []);
  const published = await testClient()`select published_at from bridge.outbox where id = ${event!.id}`;
  assert.ok(published[0]!.published_at);
});
