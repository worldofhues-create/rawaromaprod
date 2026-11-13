/**
 * STAGE-2-RP: what the release does to a batch that already exists when it is deployed.
 *
 * The promise rules are in force from the first minute (docs/releases/stage-2-rp.md section 1.1), so the
 * owner has to know what happens to the batches on the floor that day. This test holds one batch in each
 * state production (ee14722) can hold (test-support/fixtures/stage2-legacy-batches.sql: only columns that
 * exist at ee14722) and drives each through the released code. Each test is a sentence of the answer.
 *
 * It runs in the ordinary suite, where the fixture is applied to the test database (the migrations'
 * new columns are null or at their default on such rows, exactly as on a row that pre-dates them). It
 * was also run against a database built at ee14722, given these rows, and THEN migrated forward:
 *   STAGE2_LEGACY_TAG=<tag>  the rows were applied before the migration; the test must find them there
 *                            and applies nothing itself (it fails if a row is missing).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import 'reflect-metadata';
import { sql as dsql } from 'drizzle-orm';
import { assertNotMacerating, fgPromiseBlockOf, type BridgeEmitTx } from '@core/backend-kernel';
import { BatchService as ProductionBatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { BatchService as PackagingBatchService } from '../../../cluster-packaging/src/batch/batch.service.js';
import { ensureSchema, packagingDb, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { QcFloorService } from '../prodfloor/qc-floor.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { MacerationService } from '../floor-ops/maceration.service.js';

const PRE_MIGRATED = !!process.env.STAGE2_LEGACY_TAG;
const TAG = process.env.STAGE2_LEGACY_TAG ?? randomUUID().slice(0, 8);
const id = (name: string) => { const h = createHash('md5').update(TAG + name).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const oil = (n: string) => id('oil' + n);
const DAY = 86_400_000;

let batches: ProductionBatchService, fg: PackagingBatchService, qc: QcFloorService, mac: MacerationService;
const qcA = principal({ userId: randomUUID(), roles: ['qc'] });
const owner = principal({ userId: randomUUID(), roles: ['owner'] });
const op = principal();
let results: Array<{ checkpointId: string; pass: boolean }>;
const sql = () => testClient();

/** What a person is told: 'ok', or the refusal's own sentence. */
const said = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return 'ok'; } catch (e) { return (e as Error).message; } };
const run = async (n: string) => (await sql()`select maceration_run_id::text as id, started_at, min_days, max_days, rule_days, rule_version, rule_source, status, days_rested, early_release_at
                                             from production.maceration_run where oil_batch_id = ${oil(n)} order by created_at desc limit 1`)[0];
const status = async (n: string) => String((await sql()`select status from production.oil_batch_master where oil_batch_id = ${oil(n)}`)[0]!.status);
const producedAt = async (n: string) => new Date(String((await sql()`select produced_dt from production.oil_batch_master where oil_batch_id = ${oil(n)}`)[0]!.produced_dt)).getTime();
const round = (n: string, first = true) => qc.recordRound(oil(n), { ...(first ? { productId: id('product') } : {}), results }, qcA);
const retain = (n: string) => sql()`insert into quality.qc_sample_retention (oil_batch_id, sample_code, retained_dt, status) values (${oil(n)}, ${'RS-LEG-' + n + '-' + TAG}, now(), 'ACTIVE')`;

before(async () => {
  if (!PRE_MIGRATED) await ensureSchema(); // a migrated database is the real schema already
  const have = Number((await sql()`select count(*)::int as n from production.oil_batch_master where oil_batch_id = any(${['mixed', 'qc1typed', 'rested', 'resting', 'norun', 'released', 'fgmade'].map(oil)}::uuid[])`)[0]!.n);
  if (PRE_MIGRATED) assert.equal(have, 7, `STAGE2_LEGACY_TAG=${TAG}: the seven batches must already be in this database, from before it was migrated`);
  else await sql().unsafe(readFileSync(new URL('../../../test-support/fixtures/stage2-legacy-batches.sql', import.meta.url), 'utf8').replaceAll('__TAG__', TAG));
  batches = new ProductionBatchService(productionDb());
  fg = new PackagingBatchService(packagingDb());
  qc = new QcFloorService(sql(), new PolicyService(sql()));
  mac = new MacerationService(sql());
  // QC publishes the product's checkpoints as the rule now asks (with the comparison to the reference).
  await qc.publish(id('product'), { reason: 'stage 2: the first version', checkpoints: [{ name: 'Clarity', checkType: 'PASS_FAIL' }, { name: 'Against the retained reference', checkType: 'REFERENCE', critical: true }] }, qcA);
  results = (await qc.checkpoints(id('product'))).checkpoints.map((c) => ({ checkpointId: c.id, pass: true }));
});
after(async () => closeTestClient());

const to = (n: string, target: string) => said(() => batches.transitionOilBatch(oil(n), target, op));
const nearNow = (v: unknown) => Math.abs(Date.now() - new Date(String(v)).getTime()) < 5 * 60_000;

test('MIXED, nothing decided: the rest is counted from the day it goes into maceration after the deploy, not from the day it was mixed', async () => {
  // It cannot be released or sent to rest on anything but an approved QC 1 round.
  assert.match(await to('mixed', 'RELEASED'), /cannot move from PRODUCED to RELEASED/);
  assert.match(await to('mixed', 'IN_MATURATION'), /QC 1 \(a full round on the product's checkpoints.*must be approved before the batch goes into maceration/);
  assert.equal(await said(() => round('mixed')), 'ok');
  assert.equal(await to('mixed', 'IN_MATURATION'), 'ok');
  const r = (await run('mixed'))!;
  assert.ok(nearNow(r.started_at), 'the rest starts now');
  assert.ok(new Date(String(r.started_at)).getTime() - (await producedAt('mixed')) > 9 * DAY, 'the ten days since it was mixed are not counted');
  assert.deepEqual([r.min_days, r.rule_days, r.rule_version, r.rule_source], [45, 45, 1, 'policy']);
  assert.match(await to('mixed', 'RELEASED'), /is on day 1 of 45 of maceration\. An early release needs a second person/);
});

test('MIXED with QC 1 typed as PASS before the deploy: the typed pass no longer counts; QC 1 is taken again as a round', async () => {
  assert.match(await to('qc1typed', 'IN_MATURATION'), /QC 1 \(a full round.*must be approved/);
  assert.equal(await said(() => round('qc1typed')), 'ok');
  assert.equal(await to('qc1typed', 'IN_MATURATION'), 'ok');
  assert.equal((await run('qc1typed'))!.min_days, 45);
});

test('RESTING under a run opened before the deploy, rest served: it keeps its own start and its own days; QC 2 becomes a round with a retained sample', async () => {
  const before = (await run('rested'))!;
  assert.deepEqual([before.min_days, before.max_days, before.rule_days, before.rule_version, before.rule_source], [14, 30, null, null, null], 'the migration leaves the run as it was: 14 days, not 45');
  assert.ok(Date.now() - new Date(String(before.started_at)).getTime() > 19 * DAY, 'its recorded start stands');
  // The QC 2 typed yesterday does not release it.
  assert.match(await to('rested', 'RELEASED'), /QC 2 \(a full round.*taken after the rest\) must be approved.*A typed QC result does not release a batch/);
  // The round asks for a retained sample of this batch first.
  assert.match(await said(() => round('rested')), /Retain a sample of this batch before QC 2 approves it/);
  await retain('rested');
  assert.equal(await said(() => round('rested')), 'ok');
  assert.equal(await to('rested', 'RELEASED'), 'ok');
  const after = (await run('rested'))!;
  assert.equal(after.status, 'CLOSED');
  assert.equal(String(after.started_at), String(before.started_at));
  assert.ok(Number(after.days_rested) >= 20, 'the days it really rested, from its recorded start');
  // What ALEMBIC is told: its own minimum, and rule version 0 (a run opened before the rule).
  const fact = (await sql()`select payload from bridge.outbox where type = 'batch.rest.recorded' and aggregate_id::text = ${String(after.id)}`)[0]?.payload as Record<string, unknown> | undefined;
  assert.ok(fact, 'batch.rest.recorded is sent on release');
  assert.deepEqual([fact!.required_days, fact!.rule_version, fact!.early_release], [14, 0, false]);
  assert.ok(Number(fact!.days_rested) >= 20);
});

test('RESTING under a run opened before the deploy, rest not served: it waits out its own days (14, not 45), or two people release it early', async () => {
  assert.match(await to('resting', 'RELEASED'), /is on day 4 of 14 of maceration/);
  assert.match(await said(() => round('resting')), /The batch is resting \(day 4 of 14\): QC 2 is taken when the rest ends/);
  const id = String((await run('resting'))!.id);
  assert.equal(await said(() => mac.requestEarlyRelease(id, { reasonCode: 'other', reason: 'a customer order is waiting on it' }, qcA)), 'ok');
  assert.match(await said(() => mac.approveEarlyRelease(id, { note: 'mine' }, qcA)), /You asked for this early release, so someone else must approve it/);
  assert.equal(await said(() => mac.approveEarlyRelease(id, { note: 'second person' }, owner)), 'ok');
  await retain('resting');
  assert.equal(await said(() => round('resting')), 'ok');
  assert.equal(await to('resting', 'RELEASED'), 'ok');
  const fact = (await sql()`select payload from bridge.outbox where type = 'batch.rest.recorded' and aggregate_id::text = ${id}`)[0]!.payload as Record<string, unknown>;
  assert.deepEqual([fact.required_days, fact.rule_version, fact.early_release], [14, 0, true], 'sent as an early release, never as rested');
});

test('IN_MATURATION with no rest run (its formula had no setting): it is treated as never rested, and its rest starts when it is sent back into maceration', async () => {
  assert.equal((await run('norun')), undefined);
  assert.match(await to('norun', 'RELEASED'), /has not rested\. Every batch rests 45 days between QC 1 and QC 2 \(branch rule maceration\.rest v1\)\. Send it into maceration after QC 1/);
  // The status is already IN_MATURATION, so "send it into maceration" is two presses: Hold, then maceration.
  assert.equal(await to('norun', 'IN_MATURATION'), 'ok', 'the same status again is accepted and does nothing');
  assert.equal((await run('norun')), undefined, 'and opens no rest');
  assert.equal(await said(() => round('norun')), 'ok'); // QC 1, as a round (its typed results do not count)
  assert.equal(await to('norun', 'HOLD'), 'ok');
  assert.equal(await to('norun', 'IN_MATURATION'), 'ok');
  const r = (await run('norun'))!;
  assert.ok(nearNow(r.started_at));
  assert.deepEqual([r.min_days, r.rule_version], [45, 1], 'the twelve days since it was mixed are not counted');
});

test('RELEASED before the deploy and filled: it is not held; its finished lot is numbered by the server and carries no rest or QC record', async () => {
  assert.equal(await status('released'), 'RELEASED');
  assert.equal(await said(() => productionDb().transaction((tx) => assertNotMacerating(tx as unknown as BridgeEmitTx, { oilBatchId: oil('released') }, 'be packed'))), 'ok');
  const kg = String((await sql()`select uom_id::text as u from platform.uom_master where lower(uom_code) = 'kg' limit 1`)[0]!.u);
  const made = (await fg.produceFinishedGoodBatch({ packageOrderId: id('pkgreleased'), productSkuId: id('sku'), producedQty: 4, uomId: kg } as never, op)) as { batch: { batchNumber: string; finishedGoodBatchId: string } };
  assert.match(made.batch.batchNumber, /^FG-\d{4}-\d{5}$/, 'the lot is the server\'s');
  assert.equal((await sql()`select lot_assigned_at_fill from packaging.finished_good_batch_master where finished_good_batch_id = ${made.batch.finishedGoodBatchId}`)[0]!.lot_assigned_at_fill, true);
  // What the receipt will say about this lot's process: its oil batch, and nothing claimed about a rest or a QC round.
  const promise = await productionDb().transaction((tx) => fgPromiseBlockOf(tx as unknown as BridgeEmitTx, oil('released')));
  assert.deepEqual({ ...promise }, { oil_batch_no: `LEG-RELEASED-${TAG}`, rest: null, qc: null, continuity_key: null, formula_version_ref: null });
});

test('a finished batch made before the deploy keeps its typed lot number, marked as not assigned by the server', async () => {
  const row = (await sql()`select batch_number, lot_assigned_at_fill, lot_rule_version from packaging.finished_good_batch_master where finished_good_batch_id = ${id('fg')}`)[0]!;
  assert.deepEqual({ ...row }, { batch_number: `LEG-FG-${TAG}`, lot_assigned_at_fill: false, lot_rule_version: null });
});

test('the oil ledger knows what each existing batch made: the migration backfills it', async () => {
  if (PRE_MIGRATED) {
    // The database was migrated with these rows in it: each existing batch in kg has its MADE row.
    const rows = await sql()`select count(*)::int as n from production.oil_batch_movement where oil_batch_id = any(${['mixed', 'released', 'fgmade'].map(oil)}::uuid[]) and kind = 'MADE'`;
    assert.equal(rows[0]!.n, 3);
    return;
  }
  // In the ordinary suite no migration ran over these rows, so the claim is read where it is made.
  const migration = readFileSync(new URL('../../../../scripts/migrations/2026-11-20-stk-oil-ledger.sql', import.meta.url), 'utf8');
  assert.match(migration, /insert into production\.oil_batch_movement[\s\S]{0,400}'MADE'[\s\S]{0,1200}from production\.oil_batch_master/i);
});
