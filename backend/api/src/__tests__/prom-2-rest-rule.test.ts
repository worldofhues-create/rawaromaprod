/**
 * PROM-2 (LD-85, ALEMBIC docs/plan/program/process-promises.md): "Every batch rests 45 days between QC 1
 * and QC 2" is made true by the server. Real Postgres, the real oil-batch state machine, the real
 * maceration service and policy service.
 *
 *   - the rule is data (`maceration.rest`, v1 = 45 days), and a test that publishes 60 sees 60;
 *   - every batch rests, with or without a formula setting; a setting may not be shorter;
 *   - HOLD -> RELEASED and REWORK -> RELEASED without a closed rest are refused;
 *   - an early release is asked by one person and approved by ANOTHER (service and database);
 *   - QC 2 still gates after an early release;
 *   - closing the run sends `batch.rest.recorded`, which ALEMBIC's own parser accepts, and which
 *     carries no product name, material, CAS number, supplier, formula or percentage (D-1);
 *   - a malformed rule is refused at publish, a rule with no answer HOLDS, and no single record may
 *     override the rule.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import 'reflect-metadata';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { parseBatchRestRecorded } from '../../../test-support/alembic-prom.js';
import { MacerationService } from '../floor-ops/maceration.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { FACTORY_RULE_DEFAULTS } from '../../../backend-kernel/src/events/factory-rules.js';
import { bridge } from '@core/contracts';
import { typedQcIsTheVerdict } from '../../../test-support/promise-fixtures.js';

/* PROM-3: this suite is about the rest; the typed QC reading stays its verdict (promise-fixtures). The
   rounds-against-the-reference verdict, with the rest, is proved in prom-3-reference.test.ts. */
let restoreReferenceRule: (() => Promise<void>) | undefined;

let batches: BatchService;
let mac: MacerationService;
let policy: PolicyService;
const admin = principal({ userId: randomUUID(), roles: ['admin'], permissions: ['production:maceration_setting:write', 'production:maceration:release_early', 'platform:policy:write'] });
const qcHead = principal({ userId: randomUUID(), roles: ['qc'], permissions: ['production:maceration:release_early_request'] });
const op = principal();
const REST_45 = { rules: [], hasDefault: true, defaultValue: { minDays: 45, maxDays: null, appliesTo: 'every_batch', earlyRelease: 'second_person' } };

before(async () => {
  await ensureSchema();
  batches = new BatchService(productionDb());
  mac = new MacerationService(testClient());
  policy = new PolicyService(testClient());
  restoreReferenceRule = await typedQcIsTheVerdict(policy);
});
after(async () => { await restoreReferenceRule?.(); await closeTestClient(); });

/** A batch for a product with a name and a linked formula, so a leak of either would be visible. */
async function batch(opts: { formulaId?: string } = {}) {
  const sql = testClient();
  const formulaId = opts.formulaId ?? randomUUID();
  const planItem = randomUUID(), order = randomUUID();
  await sql`insert into packaging.product_master (product_id, product_code, product_name, formula_id, status)
            values (${randomUUID()}, ${'PR2-' + randomUUID().slice(0, 8)}, 'Oud Rose Vetiver', ${formulaId}, 'ACTIVE')`;
  await sql`insert into production.production_plan_items (production_plan_item_id, formula_id, planned_qty, status) values (${planItem}, ${formulaId}, 10, 'ACTIVE')`;
  await sql`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, status) values (${order}, ${planItem}, 10, 'ACTIVE')`;
  const { batch: b } = await batches.produceOilBatch({ productionOrderId: order, batchNumber: `R2-${randomUUID().slice(0, 8)}`, producedQty: 10 }, op);
  return { id: b.oilBatchId as string, no: b.batchNumber as string, formulaId };
}
const tick = () => new Promise((r) => setTimeout(r, 15));
const qc = async (id: string) => { await tick(); await batches.recordProductionQc({ oilBatchId: id, result: 'PASS' }, op); };
const age = (id: string, days: number) => testClient()`update production.maceration_run set started_at = now() - make_interval(days => ${days}) where oil_batch_id = ${id} and status = 'MACERATING'`;
const runOf = async (id: string) => (await mac.runs({ open: false })).find((r) => r.oilBatchId === id);
const restFacts = (runId: string) => testClient()`select payload from bridge.outbox where type = 'batch.rest.recorded' and aggregate_id = ${runId}`;
async function intoMaceration(id: string) { await qc(id); await batches.transitionOilBatch(id, 'IN_MATURATION', op); return (await runOf(id))!; }

test('the rule is data: v1 is the owner\'s 45 days, every batch, no maximum, early release by a second person', async () => {
  const r = await mac.rule();
  assert.equal(r.minDays, 45);
  assert.equal(r.maxDays, null);
  assert.equal(r.maxLabel, 'No maximum set');
  assert.equal(r.earlyRelease, 'second_person');
  assert.equal(r.source, 'policy');
  assert.ok(r.version >= 1);
  assert.deepEqual(FACTORY_RULE_DEFAULTS['maceration.rest'], REST_45.defaultValue, 'the registry default is the same 45');
});

test('a formula with no setting opens a 45-day run under the branch rule, with no maximum', async () => {
  const b = await batch();
  const run = await intoMaceration(b.id);
  assert.equal(run.needDays, 45);
  assert.equal(run.ruleDays, 45);
  assert.equal(run.ruleSource, 'policy');
  assert.equal(run.maxDays, null);
  await age(b.id, 400);
  assert.equal((await runOf(b.id))!.overMax, false, 'no maximum set: no over-maximum alarm, never an invented number');
});

test('HOLD -> RELEASED and REWORK -> RELEASED without a rest are refused', async () => {
  const a = await batch();
  await qc(a.id);
  await batches.transitionOilBatch(a.id, 'HOLD', op);
  await assert.rejects(() => batches.transitionOilBatch(a.id, 'RELEASED', op), /has not rested\. Every batch rests 45 days between QC 1 and QC 2 \(branch rule maceration\.rest v\d+\)/);
  const [still] = await testClient()`select status from production.oil_batch_master where oil_batch_id = ${a.id}`;
  assert.equal(still!.status, 'HOLD', 'the refused move rolled back');
  await batches.transitionOilBatch(a.id, 'REWORK', op);
  await assert.rejects(() => batches.transitionOilBatch(a.id, 'RELEASED', op), /has not rested/);
});

test('a setting shorter than the branch rule is refused at write; a longer one lengthens the rest', async () => {
  const f = randomUUID();
  await assert.rejects(() => mac.putSetting(f, { required: true, minDays: 30, maxDays: 60 }, admin),
    /The branch rule is 45 days; a shorter rest for one batch is an early release/);
  await mac.putSetting(f, { required: true, minDays: 60, maxDays: 90 }, admin);
  const b = await batch({ formulaId: f });
  const run = await intoMaceration(b.id);
  assert.equal(run.needDays, 60);
  assert.equal(run.ruleDays, 45, 'the branch rule it rested under is still recorded');
});

test('early release: a reason code is required, the requester cannot approve, a second person can; QC 2 still gates; the record says so', async () => {
  const b = await batch();
  const run = await intoMaceration(b.id);
  await assert.rejects(() => mac.requestEarlyRelease(run.macerationRunId, { reason: 'urgent trade order' }, qcHead), /reason code/);
  await assert.rejects(() => mac.requestEarlyRelease(run.macerationRunId, { reasonCode: 'quality_doubt', reason: 'urgent trade order' }, qcHead), /reason code/,
    'quality_doubt is a toward-caution code, not a reason to release early');
  await assert.rejects(() => mac.requestEarlyRelease(run.macerationRunId, { reasonCode: 'other', reason: 'soon' }, qcHead), /8 characters/);
  await mac.requestEarlyRelease(run.macerationRunId, { reasonCode: 'customer_commitment', reason: 'trade order promised for Diwali' }, qcHead);
  assert.equal((await runOf(b.id))!.readyForQc2, false, 'asking changes nothing');
  await qc(b.id);
  await assert.rejects(() => batches.transitionOilBatch(b.id, 'RELEASED', op), /second person/);
  const asker = principal({ userId: qcHead.userId, roles: ['admin'], permissions: ['production:maceration:release_early'] });
  await assert.rejects(() => mac.approveEarlyRelease(run.macerationRunId, {}, asker), /someone else must approve/);
  // The database holds the rule too, not only the service.
  await assert.rejects(() => testClient()`update production.maceration_run set early_release_approved_by = early_release_by where maceration_run_id = ${run.macerationRunId}`,
    /maceration_run_two_people_chk/);
  await mac.approveEarlyRelease(run.macerationRunId, { note: 'checked with the owner' }, admin);
  await testClient()`update production.production_qc set created_dt = now() - interval '1 day' where oil_batch_id = ${b.id}`;
  await assert.rejects(() => batches.transitionOilBatch(b.id, 'RELEASED', op), /final QC|QC 2/);
  await qc(b.id);
  await age(b.id, 31);
  assert.equal((await batches.transitionOilBatch(b.id, 'RELEASED', op)).status, 'RELEASED');
  const closed = await mac.run(run.macerationRunId);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.restShort, true);
  assert.equal(closed.daysRested, 31);
  assert.deepEqual(closed.events.map((e) => e.event), ['STARTED', 'EARLY_RELEASE_REQUESTED', 'RELEASED_EARLY', 'CLOSED']);
  const [fact] = await restFacts(run.macerationRunId);
  const p = fact!.payload as Record<string, unknown>;
  assert.equal(p.early_release, true);
  assert.equal(p.early_release_reason_code, 'customer_commitment');
  assert.equal(p.days_rested, 31);
  assert.equal(p.required_days, 45);
  const parsed = parseBatchRestRecorded(p);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.doesNotMatch(JSON.stringify(p), /Diwali|owner/, 'the free-text reason does not cross the bridge');
});

test('a declined request leaves the batch resting; the request can be asked again', async () => {
  const b = await batch();
  const run = await intoMaceration(b.id);
  await mac.requestEarlyRelease(run.macerationRunId, { reasonCode: 'instructed_by_manager', reason: 'production head asked' }, qcHead);
  await assert.rejects(() => mac.requestEarlyRelease(run.macerationRunId, { reasonCode: 'other', reason: 'asking a second time' }, qcHead), /already waiting/);
  await assert.rejects(() => mac.declineEarlyRelease(run.macerationRunId, {}, admin), /reason/);
  await mac.declineEarlyRelease(run.macerationRunId, { reason: 'the rest is the promise' }, admin);
  const after = (await runOf(b.id))!;
  assert.equal(after.earlyReleaseRequestedAt, null);
  assert.equal(after.releasedEarlyAt, null);
  await mac.requestEarlyRelease(run.macerationRunId, { reasonCode: 'other', reason: 'asked again with a reason' }, qcHead);
});

test('closing the run sends batch.rest.recorded: the shared fixture\'s shape, accepted by ALEMBIC\'s parser, no formula content', async () => {
  const b = await batch();
  const run = await intoMaceration(b.id);
  await qc(b.id);
  await age(b.id, 46);
  await batches.transitionOilBatch(b.id, 'RELEASED', op);
  const facts = await restFacts(run.macerationRunId);
  assert.equal(facts.length, 1, 'exactly one record per run');
  const p = facts[0]!.payload as Record<string, unknown>;
  const fixture = JSON.parse(readFileSync(new URL('../../../test-support/fixtures/batch-rest-recorded.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(p).sort(), Object.keys(fixture).sort(), 'the emitted fields are the contract fixture\'s fields');
  for (const k of Object.keys(fixture)) assert.equal(typeof p[k], typeof fixture[k], k);
  assert.equal(p.batch_no, b.no);
  assert.equal(p.days_rested, 46);
  assert.equal(p.rule_days, 45);
  assert.equal(p.early_release, false);
  assert.equal(p.temperature, null, 'no zone log is linked to a batch: Not on file, never inferred');
  assert.equal(bridge.checkBatchRestRecordedWire(p as never).length, 0);
  const parsed = parseBatchRestRecorded(p);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.ok(parseBatchRestRecorded(fixture).ok, 'the shared fixture parses on ALEMBIC\'s side');
  const wire = JSON.stringify(p);
  for (const leak of ['Oud Rose Vetiver', b.formulaId, 'Vetiver', 'CAS', '%']) assert.ok(!wire.includes(leak), `payload carries ${leak}`);
  assert.doesNotThrow(() => bridge.assertNoFormulaContent(p));
  // ALEMBIC refuses a payload carrying formula content, so a regression here parks rather than leaks.
  assert.equal(parseBatchRestRecorded({ ...fixture, materials: [{ name: 'Vetiver oil', cas: '8016-96-4', pct: 12 }] }).ok, false);
});

test('the rule value comes from the policy, not a constant: publish 60 and a new run rests 60', async () => {
  try {
    await policy.publish('maceration.rest', { ...REST_45, defaultValue: { ...REST_45.defaultValue, minDays: 60 } }, 'test: a longer branch rule', admin);
    const b = await batch();
    const run = await intoMaceration(b.id);
    assert.equal(run.needDays, 60);
    assert.equal(run.ruleDays, 60);
    assert.equal((await mac.rule()).minDays, 60);
  } finally {
    await policy.publish('maceration.rest', REST_45, 'test: back to the owner\'s 45', admin);
  }
  assert.equal((await mac.rule()).minDays, 45);
});

test('a malformed rule is refused at publish; a rule with no answer holds the batch; no record override', async () => {
  await assert.rejects(() => policy.publish('maceration.rest', { ...REST_45, defaultValue: { ...REST_45.defaultValue, minDays: 0 } }, 'bad', admin), /minDays/);
  await assert.rejects(() => policy.publish('maceration.rest', { ...REST_45, defaultValue: { ...REST_45.defaultValue, earlyRelease: 'one_person' } }, 'bad', admin), /second_person/);
  await assert.rejects(() => policy.publish('maceration.rest', { ...REST_45, defaultValue: { ...REST_45.defaultValue, appliesTo: 'formulas_with_setting' } }, 'bad', admin), /every_batch/);
  await assert.rejects(() => policy.override('maceration.rest', 'oil_batch', randomUUID(), { minDays: 10 }, 'urgent', admin), /early release/);
  try {
    await policy.publish('maceration.rest', { rules: [], hasDefault: false }, 'test: hold and ask', admin);
    const b = await batch();
    await qc(b.id);
    await assert.rejects(() => batches.transitionOilBatch(b.id, 'IN_MATURATION', op), /hold and ask/);
  } finally {
    await policy.publish('maceration.rest', REST_45, 'test: back to the owner\'s 45', admin);
  }
});

test('saving the rest rule needs a reason and a sign-in from the last five minutes; other policies do not', async () => {
  const stale = { ...admin, authTime: Math.floor(Date.now() / 1000) - 3600 };
  await assert.rejects(() => policy.publish('maceration.rest', REST_45, '', admin), /Say why/);
  await assert.rejects(() => policy.publish('maceration.rest', REST_45, 'an hour-old sign-in', stale), /Sign in again to save maceration\.rest/);
  await assert.rejects(() => policy.publish('qc.reference_required', { rules: [], hasDefault: true, defaultValue: { required: false } }, 'an hour-old sign-in', stale), /Sign in again/);
  assert.equal((await mac.rule()).minDays, 45, 'nothing was saved');
  // A rule that does not release product keeps its existing behaviour: the version in force is saved
  // again unchanged, so no other suite sees a different floor queue.
  const [cur] = await testClient()`select body::text as body from platform.policy_version where policy_key = 'floor.queue' order by version desc limit 1`;
  const body = cur ? JSON.parse(String(cur.body)) : { rules: [], hasDefault: true, defaultValue: { mode: 'alternate' } };
  const r = await policy.publish('floor.queue', body, 'test: a stale sign-in on another policy, same value', stale);
  assert.ok(r.version >= 1);
});
