/**
 * PROM-6 (LD-85, ALEMBIC docs/plan/program/process-promises.md PROM-6): the bridge contract, RawProd's
 * side. Real Postgres; the real policy service, oil-batch state machine, maceration service and kernel
 * readers. Every payload is run through ALEMBIC's own parsers (verbatim copies in test-support), and the
 * shared fixtures are parsed by both RawProd's checks and those parsers.
 *
 *   factory.rules.state   the reading of every factory rule with its version and the code's enforcement
 *                         version; the CAUTIOUS value across every case a version can produce; a version
 *                         the factory cannot use reads null; written in the same transaction as a factory
 *                         rule's publish and never for another policy; sent at start and once a day.
 *   batch.rest.started    sent when a batch goes into maceration and again when the rest is extended.
 *   fg.batch.received     the `promise` block of a lot filled from a released batch: its rest, QC rounds,
 *                         continuity key and formula version ref; ALEMBIC accepts it; an older shape too.
 *   D-1                   no product name, material, CAS number, supplier or person in any of them.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import 'reflect-metadata';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { parseFactoryRulesState, factoryRuleEnforced, parseBatchRestStarted, parseFgPromiseBlock } from '../../../test-support/alembic-prom.js';
import { parseFgBatchReceived } from '../../../test-support/alembic-fulfil.js';
import { MacerationService } from '../floor-ops/maceration.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { emitFactoryRulesState, FactoryRulesStateService } from '../policy/factory-rules-state.js';
import { buildFgBatchReceived } from '../shelf/shelf-task.service.js';
import { drizzleExec } from '../floor-ops/floor-util.js';
import { factoryRulesStateWire, factoryRuleReading, fgPromiseBlockOf, FACTORY_RULE_DEFAULTS, FACTORY_ENFORCEMENT_VERSION } from '@core/backend-kernel';
import { bridge } from '@core/contracts';
import { typedQcIsTheVerdict } from '../../../test-support/promise-fixtures.js';
import type { Sql } from 'postgres';

let restoreReferenceRule: (() => Promise<void>) | undefined;
let batches: BatchService, mac: MacerationService, policy: PolicyService;
const op = principal();
const editor = () => principal({ userId: randomUUID(), roles: ['admin'], permissions: ['platform:policy:write'], authTime: Math.floor(Date.now() / 1000) } as never);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../test-support/fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, any>;
const s = () => testClient();
const REST_45 = { rules: [], hasDefault: true, defaultValue: { minDays: 45, maxDays: null, appliesTo: 'every_batch', earlyRelease: 'second_person' } };
const NAME = 'Oud Rose Vetiver';

before(async () => {
  await ensureSchema();
  batches = new BatchService(productionDb());
  mac = new MacerationService(testClient());
  policy = new PolicyService(testClient());
  // This suite's batches are released on the typed QC reading (promise-fixtures), as prom-2's are.
  restoreReferenceRule = await typedQcIsTheVerdict(policy);
});
after(async () => { await restoreReferenceRule?.(); await closeTestClient(); });

const statesSince = async (t: Date) => (await s()`select payload from bridge.outbox where type = 'factory.rules.state' and occurred_at >= ${t} order by seq`) as unknown as Array<{ payload: Record<string, any> }>;
const dbNow = async () => ((await s()`select now() as t`) as unknown as Array<{ t: Date }>)[0]!.t;

/* ── factory.rules.state ───────────────────────────────────────────────────────────────────── */

test('the shared fixture is what RawProd sends, and ALEMBIC parses it', () => {
  const f = fixture('factory-rules-state.json');
  assert.deepEqual(bridge.checkFactoryRulesStateWire(f as never), []);
  const r = parseFactoryRulesState(f);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(factoryRuleEnforced(r.record, 'maceration.rest', new Date('2026-11-13T12:00:00Z')).enforced, true);
  assert.deepEqual(bridge.checkBatchRestStartedWire(fixture('batch-rest-started.json') as never), []);
  assert.ok(parseBatchRestStarted(fixture('batch-rest-started.json')).ok);
  const fg = fixture('fg-batch-received-promise.json');
  assert.deepEqual(bridge.validateFgBatchReceived(fg as never), []);
  assert.ok(parseFgBatchReceived(fg).ok);
});

test('pure: with nothing published every rule reads its registry default at version 0 and the code\'s enforcement version', () => {
  const w = factoryRulesStateWire({}, '2026-11-13T06:00:00.000Z', 'startup');
  assert.deepEqual(bridge.checkFactoryRulesStateWire(w), []);
  assert.deepEqual(w.rules['maceration.rest'], { version: 0, enforcement_version: FACTORY_ENFORCEMENT_VERSION['maceration.rest'], min_days: 45, max_days: null, early_release: 'second_person' });
  for (const k of ['qc.reference_required', 'fill.lot_server_assigned', 'continuity.supplier_change_is_material'] as const) {
    assert.deepEqual(w.rules[k], { version: 0, enforcement_version: FACTORY_ENFORCEMENT_VERSION[k], value: true }, k);
  }
  assert.equal('receiving.supplier_lot_required' in w.rules, false, 'PROM-1\'s rule is not built here: not sent, never claimed');
  const r = parseFactoryRulesState(w);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(w.branch, null);
  assert.equal(FACTORY_RULE_DEFAULTS['maceration.rest'].minDays, 45);
});

test('pure: the reading is the cautious one across every case a version can produce, and an unusable version reads null', () => {
  // One product with the reference rule off makes "checked against a retained reference" untrue for the house.
  const someOff = { rules: [{ id: 'r1', when: [{ field: 'product', op: 'eq', value: 'P-1' }], then: { required: false } }], hasDefault: true, defaultValue: { required: true } };
  assert.deepEqual(factoryRuleReading('qc.reference_required', { version: 7, body: JSON.stringify(someOff) }), { version: 7, enforcement_version: 1, value: false });
  // The rest's minimum is the smallest any case rests under; one case with no maximum means none is promised.
  const twoRests = { rules: [{ id: 'r1', when: [], then: { minDays: 60, maxDays: 90, appliesTo: 'every_batch', earlyRelease: 'second_person' } }], hasDefault: true, defaultValue: REST_45.defaultValue };
  assert.deepEqual(factoryRuleReading('maceration.rest', { version: 4, body: twoRests }), { version: 4, enforcement_version: 1, min_days: 45, max_days: null, early_release: 'second_person' });
  // A version whose values cannot be used holds every batch; nothing is claimed for it.
  assert.equal(factoryRuleReading('maceration.rest', { version: 5, body: { rules: [], hasDefault: true, defaultValue: { minDays: 0 } } }), null);
  assert.equal(factoryRuleReading('qc.reference_required', { version: 5, body: { rules: [], hasDefault: false } }), null, 'no case answers: it holds');
  assert.equal(factoryRuleReading('fill.lot_server_assigned', { version: 2, body: '{not json' }), null);
  const w = factoryRulesStateWire({ 'maceration.rest': { version: 5, body: { rules: [], hasDefault: true, defaultValue: { minDays: 0 } } } }, '2026-11-13T06:00:00.000Z', 'daily');
  const r = parseFactoryRulesState(w);
  assert.ok(r.ok && r.record.rules['maceration.rest'] === null, 'null is a valid reading, and ALEMBIC reads it as not enforced');
  assert.equal(factoryRuleEnforced(r.ok ? r.record : null, 'maceration.rest', new Date('2026-11-13T07:00:00Z')).enforced, false);
});

test('publishing a factory rule writes factory.rules.state in the same transaction; another policy writes none', async () => {
  const t0 = await dbNow();
  const v = await policy.publish('maceration.rest', REST_45, 'PROM-6 test: the same 45 days, a new version', editor());
  const states = await statesSince(t0);
  assert.equal(states.length, 1);
  const p = states[0]!.payload;
  assert.equal(p.reason, 'rule_change');
  assert.equal(p.rules['maceration.rest'].version, v.version, 'the state names the version just published');
  assert.equal(p.rules['maceration.rest'].min_days, 45);
  const r = parseFactoryRulesState(p);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(factoryRuleEnforced(r.record, 'maceration.rest', new Date(p.as_of)).enforced, true);
  const t1 = await dbNow();
  const other = await policy.publish('qc.rework', { rules: [], hasDefault: true, defaultValue: { maxReworks: 2 } }, 'PROM-6 test: not a factory rule', editor());
  assert.ok(other.version >= 1, 'the other policy did publish');
  assert.equal((await statesSince(t1)).length, 0, 'a policy the promises do not rest on is not reported');
  const text = JSON.stringify(p);
  for (const word of [NAME, 'userId', 'created_by', 'reason":"PROM']) assert.ok(!text.includes(word), word);
});

test('the daily sender sends at start, then not again within 23 hours; a refused state is never written', async () => {
  const svc = new FactoryRulesStateService(testClient());
  const t0 = await dbNow();
  assert.equal(await svc.tick('startup'), true);
  assert.equal(await svc.tick('daily'), false, 'one was sent moments ago');
  // Age every recent state past the window (this test database is the lane's own; files run one at a time).
  await s()`update bridge.outbox set occurred_at = occurred_at - interval '24 hours' where type = 'factory.rules.state' and occurred_at > now() - interval '23 hours'`;
  const t1 = await dbNow();
  assert.equal(await svc.tick('daily'), true, 'none in the last 23 hours: send');
  assert.equal(await svc.tick('daily'), false, 'and then not again');
  const sent = await statesSince(t1);
  assert.deepEqual(sent.map((x) => x.payload.reason), ['daily']);
  assert.ok(parseFactoryRulesState(sent[0]!.payload).ok);
  assert.ok(t0 <= t1);
  await assert.rejects(() => (testClient() as Sql).begin((tx) => emitFactoryRulesState(tx, 'manual' as never)), /refused by ALEMBIC/);
});

/* ── batch.rest.started ────────────────────────────────────────────────────────────────────── */

async function batch() {
  const formulaId = randomUUID(), planItem = randomUUID(), order = randomUUID();
  await s()`insert into packaging.product_master (product_id, product_code, product_name, formula_id, status)
            values (${randomUUID()}, ${'PR6-' + randomUUID().slice(0, 8)}, ${NAME}, ${formulaId}, 'ACTIVE')`;
  await s()`insert into production.production_plan_items (production_plan_item_id, formula_id, planned_qty, status) values (${planItem}, ${formulaId}, 10, 'ACTIVE')`;
  await s()`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status) values (${order}, ${planItem}, 10, 'ACTIVE')`;
  const { batch: b } = await batches.produceOilBatch({ productionOrderId: order, producedQty: 10 }, op);
  return { id: b.oilBatchId as string, no: b.batchNumber as string };
}
const tick = () => new Promise((r) => setTimeout(r, 15));
const qc = async (id: string) => { await tick(); await batches.recordProductionQc({ oilBatchId: id, result: 'PASS' }, op); };
const runOf = async (id: string) => (await mac.runs({ open: false })).find((r) => r.oilBatchId === id);
const starts = (runId: string) => s()`select payload from bridge.outbox where type = 'batch.rest.started' and aggregate_id = ${runId} order by seq` as unknown as Promise<Array<{ payload: Record<string, any> }>>;

test('a batch going into maceration sends batch.rest.started, and an extension sends the later schedule', async () => {
  const b = await batch();
  await qc(b.id);
  await batches.transitionOilBatch(b.id, 'IN_MATURATION', op);
  const run = (await runOf(b.id))!;
  let sent = await starts(run.macerationRunId);
  assert.equal(sent.length, 1);
  const p = sent[0]!.payload;
  assert.equal(p.batch_no, b.no);
  assert.equal(p.required_days, 45);
  assert.equal(Date.parse(p.release_due_at) - Date.parse(p.started_at), 45 * 86_400_000);
  const parsed = parseBatchRestStarted(p);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const admin = principal({ userId: randomUUID(), roles: ['admin'], permissions: ['production:maceration:extend'] });
  await mac.extend(run.macerationRunId, { days: 5, reason: 'PROM-6 test: the oil needs longer' }, admin);
  sent = await starts(run.macerationRunId);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.payload.required_days, 50);
  assert.equal(Date.parse(sent[1]!.payload.release_due_at) - Date.parse(sent[1]!.payload.started_at), 50 * 86_400_000);
  assert.ok(parseBatchRestStarted(sent[1]!.payload).ok);
  const text = JSON.stringify(sent.map((x) => x.payload));
  for (const word of [NAME, 'PROM-6 test', admin.userId, op.userId]) assert.ok(!text.includes(word), word);
});

/* ── fg.batch.received promise block ───────────────────────────────────────────────────────── */

test('a lot filled from a released batch carries its rest and QC record; ALEMBIC accepts the receipt; D-1 holds', async () => {
  const b = await batch();
  await qc(b.id);
  await batches.transitionOilBatch(b.id, 'IN_MATURATION', op);
  await s()`update production.maceration_run set started_at = started_at - make_interval(days => min_days + extend_days) where oil_batch_id = ${b.id} and status = 'MACERATING'`;
  await qc(b.id);
  await batches.transitionOilBatch(b.id, 'RELEASED', op);
  const block = await fgPromiseBlockOf(drizzleExec(testClient()), b.id);
  assert.ok(block);
  assert.equal(block.oil_batch_no, b.no);
  assert.ok(block.rest, 'the closed rest');
  assert.equal(block.rest.days_rested, 45);
  assert.equal(block.rest.early_release, false);
  assert.equal(block.qc, null, 'released on the typed reading in this suite: no staged QC round, so Not on file, never invented');
  assert.deepEqual(bridge.checkFgPromiseBlockWire(block, b.no), []);
  const built = buildFgBatchReceived({
    batchNo: 'FG-2611-' + randomUUID().slice(0, 5), sku: 'FG-PR6', packSize: '25 kg', qty: 4, uomCode: 'pcs', rack: 'R01-S2-B3',
    releasedAt: new Date().toISOString(), qcBatchNo: b.no, compounded: true, lotAssignedAtFill: true, promise: block,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const alembic = parseFgBatchReceived(built.payload);
  assert.ok(alembic.ok, JSON.stringify(alembic));
  assert.equal(alembic.fact.promise?.rest?.daysRested, 45);
  assert.equal(alembic.fact.promise?.oilBatchNo, b.no);
  const text = JSON.stringify(built.payload);
  for (const word of [NAME, 'CAS', 'supplier', 'vendor', op.userId]) assert.ok(!text.includes(word), word);
  // A receipt that names another batch than QC released is refused here before ALEMBIC would park it.
  const wrong = buildFgBatchReceived({
    batchNo: 'FG-2611-X', sku: 'FG-PR6', packSize: '25 kg', qty: 4, uomCode: 'pcs', rack: 'R01-S2-B3',
    releasedAt: new Date().toISOString(), qcBatchNo: 'B-OTHER', compounded: true, promise: block,
  });
  assert.equal(wrong.ok, false);
  // The older shape, with no block, still parses on ALEMBIC's side.
  const old = buildFgBatchReceived({ batchNo: 'FG-2611-Y', sku: 'FG-PR6', packSize: '25 kg', qty: 4, uomCode: 'pcs', rack: 'R01-S2-B3', releasedAt: new Date().toISOString(), qcBatchNo: b.no, compounded: true });
  assert.ok(old.ok && !('promise' in old.payload));
  const p = parseFgBatchReceived(old.ok ? old.payload : {});
  assert.ok(p.ok && p.fact.promise === null);
  assert.ok(parseFgPromiseBlock(undefined).ok);
});
