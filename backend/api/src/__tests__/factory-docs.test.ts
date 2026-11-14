/**
 * FACTORY-DOCS — the three facts a customer's documents are made from, end to end on RawProd's side,
 * on real Postgres with the real services and the real relay (stubbed transport only), and each one
 * run through ALEMBIC's OWN receiver code loaded from an ALEMBIC checkout (alembic-checkout.ts).
 *
 *   qc.gcms.attached                    QC attaches a lab's GC-MS PDF: one fact per (batch, file), the
 *                                       file's SHA-256 on it, the same file again sends nothing; the
 *                                       relay mints a signed, expiring file.url per attempt and the
 *                                       link serves exactly those bytes; no base URL -> nothing sent.
 *   qc.batch.released                   both verdicts parse as ALEMBIC parses them.
 *   compliance.certificate.calculated   a FIXTURE formula through the Vault's real calculation, the
 *                                       main box's sync and the relay: no material id, ingredient
 *                                       name, line percentage or formula id in the fact, the outbox
 *                                       row, the signed body or any log line.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Logger, type LoggerService } from '@nestjs/common';
import { bridge as contracts } from '@core/contracts';
import type { InternalCertificate } from '@ra/cluster-formula';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { CoaService } from '../../../cluster-production/src/coa/coa.service.js';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import {
  calculateAllergens, calculateIfra, type FormulaLine, type MaterialComplianceData,
} from '../../../cluster-formula/src/compliance/compliance-calc.js';
import { BridgeRelayService } from '../bridge/relay.service.js';
import { GcmsFileService } from '../bridge/gcms-file.controller.js';
import { sealSecret } from '../bridge/secret-box.js';
import { verifyBody } from '../bridge/signing.js';
import { ComplianceCertificateSyncService, CERTIFICATE_CURSOR_ID } from '../vault-bridge/compliance-certificate-sync.service.js';
import { installUploadBodyLimitsOn, UPLOAD_BODY_LIMIT_BYTES } from '../upload-body-limits.js';
import { ensureSchema, productionDb, bridgeDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { alembicSkipReason, alembicVerdicts } from '../../../test-support/alembic-checkout.js';

const SECRET = 'factory-docs-test-secret';
const WEBHOOK = 'https://alembic.example.test/api/v1/bridge/rawprod/webhooks/in';
const FILE_BASE = 'https://rawfactory.example.test';
const TENANT = randomUUID();
const qc = principal({ userId: randomUUID(), roles: ['qc'] });
const ALEMBIC_SKIP = alembicSkipReason();

let coa: CoaService;
let batches: BatchService;

/** Every log line any service writes while this file runs. */
const logLines: string[] = [];
const capture: LoggerService = {
  log: (m: unknown, ...r: unknown[]) => void logLines.push([m, ...r].map(String).join(' ')),
  error: (m: unknown, ...r: unknown[]) => void logLines.push([m, ...r].map(String).join(' ')),
  warn: (m: unknown, ...r: unknown[]) => void logLines.push([m, ...r].map(String).join(' ')),
  debug: (m: unknown, ...r: unknown[]) => void logLines.push([m, ...r].map(String).join(' ')),
  verbose: (m: unknown, ...r: unknown[]) => void logLines.push([m, ...r].map(String).join(' ')),
};

before(async () => {
  Logger.overrideLogger(capture);
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  await testClient()`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
            values ('default', true, ${WEBHOOK}, ${sealSecret(SECRET)})
            on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url,
                                           hmac_secret_sealed = excluded.hmac_secret_sealed`;
  coa = new CoaService(productionDb());
  batches = new BatchService(productionDb());
});
after(async () => { await closeTestClient(); });

const allSent: { headers: Record<string, string>; body: string }[] = [];

function relayWith(extra: Record<string, string> = {}) {
  const config = new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/unused', JWT_SECRET: 'x'.repeat(32), ALEMBIC_ASSERTION_TENANT_ID: TENANT, ...extra,
  });
  const relay = new BridgeRelayService(bridgeDb(), config);
  const sent: { headers: Record<string, string>; body: string }[] = [];
  relay.fetchImpl = async (_url, init) => {
    const one = { headers: init!.headers as Record<string, string>, body: String(init!.body) };
    sent.push(one);
    allSent.push(one); // a drain sends every due row, so an event may go out in another test's drain
    return new Response('{"outcome":"applied"}', { status: 200 });
  };
  return { relay, sent };
}

/** Drain until the event is delivered (other suites' queued rows go first). */
async function deliver(eventId: string, extra: Record<string, string> = {}) {
  const { relay } = relayWith(extra);
  for (let i = 0; i < 60 && !allSent.some((s) => s.headers['x-bridge-event-id'] === eventId); i++) await relay.drain();
  relay.onModuleDestroy();
  return allSent.find((s) => s.headers['x-bridge-event-id'] === eventId);
}

async function fixture() {
  const sql = testClient();
  const formulaId = randomUUID();
  const productId = randomUUID();
  const productCode = `FD-${productId.slice(0, 8)}`;
  await sql`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
            values (${productId}, ${formulaId}, ${productCode}, 'Althair', 'ACTIVE')`;
  await sql`insert into packaging.product_sku (product_id, sku_code, pack_size, status) values (${productId}, ${`${productCode}-25KG`}, '25KG', 'ACTIVE')`;
  const planItemId = randomUUID();
  await sql`insert into production.production_plan_items (production_plan_item_id, formula_id, status) values (${planItemId}, ${formulaId}, 'ACTIVE')`;
  const orderId = randomUUID();
  await sql`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status)
            values (${orderId}, ${planItemId}, 25, 'COMPLETED')`;
  const { batch } = await batches.produceOilBatch({ productionOrderId: orderId, producedQty: 25, producedDt: '2026-02-14T08:00:00.000Z' }, qc);
  await coa.upsertSpec(productId, { sgMin: 0.95, sgMax: 1.5, flashPointMinC: 110, flashPointMaxC: 120, shelfLifeMonths: 24 }, qc);
  const { coa: row } = await coa.recordCoa({
    oilBatchId: batch.oilBatchId, sgResult: 0.995, flashPointResultC: 116, colourAppearance: 'Deep Brown', colourAppearancePass: true,
    odourDescription: 'Warm Spicy Vanilla Fragrance', odourPass: true, photos: [],
  }, qc);
  return { productId, productCode, batch, coaId: row.batchCoaId };
}

async function outbox(aggregateId: string, type: string) {
  return testClient()`select id::text, type, payload from bridge.outbox where aggregate_id = ${aggregateId} and type = ${type} order by seq`;
}

/** A small but real-looking PDF; `tag` makes each file's bytes (and hash) distinct. */
function pdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj <<>> endobj\n% GC-MS report ${tag}\ntrailer <<>>\n%%EOF\n`, 'latin1');
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const GCMS = (file: Buffer, over: Record<string, string> = {}) => ({
  fileBase64: file.toString('base64'), fileName: 'gcms.pdf', labName: 'Indore Analytical Lab', reportRef: 'IAL/26/0412', analysedOn: '2026-02-15', ...over,
});

/* ── qc.gcms.attached ────────────────────────────────────────────────────────────────────── */

test('attaching a GC-MS PDF writes exactly one qc.gcms.attached carrying the file hash; the same file again sends nothing', async () => {
  const f = await fixture();
  await coa.releaseCoa(f.coaId, qc);
  const file = pdf(randomUUID());
  const first = await coa.attachGcms(f.coaId, GCMS(file), qc);
  assert.equal(first.emitted, true);
  assert.equal(first.report.sha256, sha(file));

  const again = await coa.attachGcms(f.coaId, GCMS(file, { reportRef: 'typed again' }), qc);
  assert.equal(again.emitted, false, 'the same file for the same batch is not a new report');
  assert.equal(again.report.batchGcmsReportId, first.report.batchGcmsReportId);

  const rows = await outbox(f.coaId, 'qc.gcms.attached');
  assert.equal(rows.length, 1);
  const p = rows[0]!.payload as Record<string, unknown>;
  assert.equal(p.batch_no, f.batch.batchNumber);
  assert.deepEqual(p.product_ref, { factory_sku: `${f.productCode}-25KG` });
  assert.equal(p.sha256, sha(file));
  assert.equal(p.lab_name, 'Indore Analytical Lab');
  assert.equal(p.report_ref, 'IAL/26/0412');
  assert.equal(p.analysed_on, '2026-02-15');
  assert.equal(p.file, undefined, 'no link is stored: the relay mints it at send time');
  assert.equal(p[contracts.GCMS_REPORT_META_KEY], first.report.batchGcmsReportId);

  const second = await coa.attachGcms(f.coaId, GCMS(pdf(randomUUID()), { reportRef: 'IAL/26/0413' }), qc);
  assert.equal(second.emitted, true, 'a different file is a new report');
  assert.equal((await outbox(f.coaId, 'qc.gcms.attached')).length, 2);
  assert.equal((await coa.listGcms(f.coaId)).length, 2);
});

test('a file that is not a PDF, an oversized file, a future analysis date and a rejected batch are refused, and nothing is sent', async () => {
  const f = await fixture();
  await assert.rejects(() => coa.attachGcms(f.coaId, GCMS(Buffer.from('PK\u0003\u0004 a zip, not a pdf')), qc),
    (e: unknown) => e instanceof BadRequestException && /not a PDF/.test((e as Error).message));
  const big = Buffer.concat([pdf('big'), Buffer.alloc(contracts.GCMS_MAX_BYTES)]);
  await assert.rejects(() => coa.attachGcms(f.coaId, GCMS(big), qc), BadRequestException);
  await assert.rejects(() => coa.attachGcms(f.coaId, GCMS(pdf('x'), { analysedOn: '2999-01-01' }), qc), BadRequestException);
  await coa.rejectCoa(f.coaId, 'off odour on the retained sample', qc);
  await assert.rejects(() => coa.attachGcms(f.coaId, GCMS(pdf('rej')), qc), ConflictException);
  assert.equal((await outbox(f.coaId, 'qc.gcms.attached')).length, 0);
});

test('the relay sends a signed, expiring file.url that serves exactly the hashed bytes, and only while it is valid', async () => {
  const f = await fixture();
  await coa.releaseCoa(f.coaId, qc);
  const file = pdf(randomUUID());
  const { report } = await coa.attachGcms(f.coaId, GCMS(file), qc);
  const [ev] = await outbox(f.coaId, 'qc.gcms.attached');
  const before = Date.now();
  const ours = await deliver(ev!.id, { BRIDGE_FILE_BASE_URL: FILE_BASE });
  assert.ok(ours, 'delivered');
  assert.equal(verifyBody(ours.body, SECRET, ours.headers['x-bridge-signature']), true);
  const env = JSON.parse(ours.body);
  assert.equal(env.type, 'qc.gcms.attached');
  assert.deepEqual(env.aggregate, { type: 'qc_batch', id: f.coaId });
  assert.equal(env.org_id, TENANT);
  assert.equal(env.payload[contracts.GCMS_REPORT_META_KEY], undefined, 'transport metadata never reaches ALEMBIC');
  assert.deepEqual(contracts.checkQcGcmsAttachedWire(env.payload), []);

  const url = new URL(env.payload.file.url);
  assert.equal(url.origin, FILE_BASE);
  assert.equal(url.pathname, `/v1/bridge/files/gcms/${report.batchGcmsReportId}`);
  const exp = Number(url.searchParams.get('exp'));
  assert.ok(exp * 1000 >= before + contracts.GCMS_FILE_URL_TTL_SECONDS * 1000 - 2000, 'lives the full TTL');
  assert.ok(contracts.GCMS_FILE_URL_TTL_SECONDS >= 15 * 60, 'ALEMBIC asks for at least 15 minutes');

  const files = new GcmsFileService(bridgeDb());
  const q = Object.fromEntries(url.searchParams);
  const got = await files.open(report.batchGcmsReportId, q, Date.now());
  assert.ok(got.ok);
  assert.equal(sha(got.bytes), env.payload.sha256, 'the bytes behind the link hash to the sha256 the fact carries');
  assert.ok(contracts.isPdfBytes(got.bytes));

  assert.deepEqual(await files.open(report.batchGcmsReportId, q, exp * 1000 + 1000), { ok: false, reason: 'expired' });
  assert.deepEqual(await files.open(report.batchGcmsReportId, { ...q, sig: q.sig!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }, Date.now()),
    { ok: false, reason: 'bad_signature' });
  assert.deepEqual(await files.open(randomUUID(), q, Date.now()), { ok: false, reason: 'bad_signature' }, 'a link is for one report');
  assert.deepEqual(await files.open(report.batchGcmsReportId, { ...q, sha: sha(pdf('other')) }, Date.now()), { ok: false, reason: 'bad_signature' });
});

test('with no BRIDGE_FILE_BASE_URL a GC-MS fact is not sent: it stays queued with the reason on its delivery row', async () => {
  const f = await fixture();
  await coa.attachGcms(f.coaId, GCMS(pdf(randomUUID())), qc);
  const [ev] = await outbox(f.coaId, 'qc.gcms.attached');
  const { relay, sent } = relayWith();
  for (let i = 0; i < 60; i++) {
    await relay.drain();
    const d = await testClient()`select attempts from bridge.outbox_delivery where outbox_id = ${ev!.id}::uuid`;
    if (d[0]) break;
  }
  relay.onModuleDestroy();
  assert.equal(sent.some((s) => s.headers['x-bridge-event-id'] === ev!.id), false);
  const [d] = await testClient()`select last_error from bridge.outbox_delivery where outbox_id = ${ev!.id}::uuid`;
  assert.match(String(d!.last_error), /BRIDGE_FILE_BASE_URL/);
  const [o] = await testClient()`select published_at from bridge.outbox where id = ${ev!.id}::uuid`;
  assert.equal(o!.published_at, null);
});

test('the GC-MS upload route and the console channel get the larger body limit, and no other route does', () => {
  let hook: ((o: { method: string | string[]; url: string; bodyLimit?: number }) => void) | undefined;
  installUploadBodyLimitsOn({ addHook: (_n, fn) => { hook = fn; } });
  const route = (method: string, url: string) => { const o: { method: string; url: string; bodyLimit?: number } = { method, url }; hook!(o); return o.bodyLimit; };
  assert.equal(route('POST', '/v1/batch-coas/:id/gcms'), UPLOAD_BODY_LIMIT_BYTES);
  assert.equal(route('POST', '/rpc'), UPLOAD_BODY_LIMIT_BYTES);
  assert.equal(route('POST', '/v1/batch-coas'), undefined);
  assert.equal(route('GET', '/rpc'), undefined);
  // 5 MB of PDF, base64 in JSON, sealed and base64'd again, fits; and the limit is under nginx's 12m.
  assert.ok(Math.ceil(contracts.GCMS_MAX_BYTES * 4 / 3) * 4 / 3 + 4096 < UPLOAD_BODY_LIMIT_BYTES);
  assert.ok(UPLOAD_BODY_LIMIT_BYTES < 12 * 1024 * 1024);
});

/* ── ALEMBIC's own receiver, on what the relay actually sent ─────────────────────────────── */

test('ALEMBIC accepts qc.batch.released (both verdicts) and qc.gcms.attached exactly as the relay sends them', { skip: ALEMBIC_SKIP }, async () => {
  const passed = await fixture();
  await coa.releaseCoa(passed.coaId, qc);
  await coa.attachGcms(passed.coaId, GCMS(pdf(randomUUID())), qc);
  const failed = await fixture();
  await coa.rejectCoa(failed.coaId, 'flash point drifted on re-test', qc);

  const evs = [
    ...(await outbox(passed.coaId, 'qc.batch.released')),
    ...(await outbox(passed.coaId, 'qc.gcms.attached')),
    ...(await outbox(failed.coaId, 'qc.batch.released')),
  ];
  assert.equal(evs.length, 3);
  const bodies = [];
  for (const ev of evs) {
    const ours = await deliver(ev.id, { BRIDGE_FILE_BASE_URL: FILE_BASE });
    assert.ok(ours, `${ev.type} delivered`);
    bodies.push(JSON.parse(ours.body));
  }
  assert.deepEqual(bodies.map((b) => b.payload.status ?? b.type), ['passed', 'qc.gcms.attached', 'failed']);
  const verdicts = alembicVerdicts([
    ...bodies.map((b) => ({ kind: 'envelope' as const, envelope: b })),
    ...bodies.map((b) => ({ kind: b.type, payload: b.payload })),
  ]);
  assert.deepEqual(verdicts, verdicts.map(() => ({ ok: true })), JSON.stringify(verdicts));
});

/* ── compliance.certificate.calculated: no formula content leaves the Vault ──────────────── */

test('a fixture formula through the Vault calculation, the sync and the relay: ALEMBIC accepts the result and no formula content appears anywhere', async () => {
  // FIXTURE ONLY. Distinctive ids, names and line percentages, so any leak is findable by search.
  const mat = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
  const NAMES = ['FIXTURE-OAKMOSS-QX7', 'FIXTURE-GALAXOLIDE-ZK3', 'FIXTURE-DPG-WV9'];
  const PCTS = [41.3791, 23.8137, 34.8072];
  const lines: FormulaLine[] = [
    { materialId: mat.a, percentage: PCTS[0]! }, { materialId: mat.b, percentage: PCTS[1]! }, { materialId: mat.c, percentage: PCTS[2]! },
  ];
  const data = new Map<string, MaterialComplianceData>([
    [mat.a, { materialId: mat.a, allergenComplete: true, allergens: [{ cas: '126-90-9', naturalPct: 12.5, syntheticPct: 0 }],
      ifraComplete: true, ifraAmendment: '51', ifra: [{ category: '4', restrictionType: 'RESTRICTED', maxPct: 1.7, amendment: '51' }] }],
    [mat.b, { materialId: mat.b, allergenComplete: true, allergens: [{ cas: '138-86-3', naturalPct: 0, syntheticPct: 3.25 }],
      ifraComplete: true, ifraAmendment: '51', ifra: [{ category: '1', restrictionType: 'PROHIBITED', maxPct: null, amendment: '51' }] }],
    [mat.c, { materialId: mat.c, allergenComplete: true, allergens: [], ifraComplete: true, ifraAmendment: '51', ifra: [] }],
  ]);
  const refs = contracts.EU_ALLERGEN_CAS_26.map((cas) => ({ name: `Regulated allergen ${cas}`, cas }));
  const ifra = calculateIfra(lines, data, '51');
  const allergen = calculateAllergens(lines, data, refs, 0);
  assert.ok(ifra.ok && allergen.ok, 'the fixture is complete');

  const formulaId = randomUUID();
  const productId = randomUUID();
  const code = `FDC-${productId.slice(0, 8)}`;
  await testClient()`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
                     values (${productId}, ${formulaId}, ${code}, 'Cert product', 'ACTIVE')`;
  await testClient()`insert into packaging.product_sku (product_id, sku_code, status) values (${productId}, ${`${code}-1KG`}, 'ACTIVE')`;
  const cursor = await testClient()`select last_seq from bridge.vault_sync_cursor where id = ${CERTIFICATE_CURSOR_ID}`;
  const base = cursor[0] ? Number(cursor[0].last_seq) : 0;
  const ref = `fvr_${randomBytes(16).toString('hex')}`;
  const certs: InternalCertificate[] = [
    { seq: base + 1, certificateId: randomUUID(), formulaId, formulaVersionRef: ref, formulaVersionNumber: 4, kind: 'ifra', amendment: '51',
      values: ifra.values, calculatedAt: new Date().toISOString() },
    { seq: base + 2, certificateId: randomUUID(), formulaId, formulaVersionRef: ref, formulaVersionNumber: 4, kind: 'allergen', amendment: null,
      values: allergen.values, calculatedAt: new Date().toISOString() },
  ];
  const vault = { complianceCertificates: async (after: number, limit: number) => certs.filter((c) => c.seq > after).slice(0, limit) };
  const sync = new ComplianceCertificateSyncService(bridgeDb(), vault as never, new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/unused', JWT_SECRET: 'x'.repeat(32),
    VAULT_API_INTERNAL_URL: 'http://vault.internal.invalid:3001', INTERNAL_BRIDGE_KEY: 'k'.repeat(40),
  }));
  await sync.sync();

  const rows = await outbox(productId, 'compliance.certificate.calculated');
  assert.equal(rows.length, 2, 'one IFRA and one allergen certificate');
  const bodies: string[] = [];
  for (const r of rows) {
    const ours = await deliver(r.id);
    assert.ok(ours);
    bodies.push(ours.body);
  }
  const rawRows = await testClient()`select payload::text as t from bridge.outbox where aggregate_id = ${productId}`;
  const haystacks: Record<string, string> = {
    'outbox rows': rawRows.map((r) => r.t as string).join('\n'),
    'signed bodies': bodies.join('\n'),
    'log lines': logLines.join('\n'),
  };
  const needles = [...Object.values(mat), ...NAMES, ...PCTS.map(String), formulaId];
  for (const [where, hay] of Object.entries(haystacks)) {
    for (const n of needles) assert.equal(hay.includes(n), false, `"${n}" (formula content) found in ${where}`);
  }
  const wires = bodies.map((b) => JSON.parse(b));
  for (const w of wires) {
    contracts.assertNoFormulaContent(w.payload);
    assert.equal(w.payload.formula_version_ref, ref);
    assert.equal(w.payload.formula_version, 4);
  }
  // The calculated results did cross: IFRA category 1 is 0 (a prohibited material is present).
  assert.equal(wires.find((w) => w.payload.kind === 'ifra').payload.values.limits['1'], '0.00');

  if (ALEMBIC_SKIP) return;
  const verdicts = alembicVerdicts([
    ...wires.map((w) => ({ kind: 'envelope' as const, envelope: w })),
    ...wires.map((w) => ({ kind: 'compliance.certificate.calculated' as const, payload: w.payload })),
  ]);
  assert.deepEqual(verdicts, verdicts.map(() => ({ ok: true })), JSON.stringify(verdicts));
});
