/**
 * Always-on Ruh — the watch engine end to end on this box (ruh/ruh-watch.service.ts): real facts
 * from a real database (RuhFactsService), the pure detectors, the insight store and the C3 queue,
 * with the Vault played by a fake signed-channel client that answers COUNTS and overrides.
 *
 *   - a blocked requirement and a predicted-late one open their notes, mirrored to ALEMBIC;
 *   - running again changes nothing; the requirement getting planned clears its note (resolve queued);
 *   - an override made on the Vault box becomes an urgent admin note + a C3 override signal, ONCE
 *     (cursor), and nothing in that signal identifies a formula;
 *   - when the Vault does not answer, its count notes stay as they were (this box's own two are
 *     still checked); 0 turns the engine's timer off.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as bridgeSchema from '@ra/data-bridge';
import { ProduceQueueService } from '@ra/cluster-production';
import { ensureSchema, testClient, closeTestClient, TEST_DATABASE_URL, productionDb, principal } from '../../../test-support/db.js';
import { kgUom, productWithSku, requirement } from '../../../test-support/produce-fixtures.js';
import { RuhFactsService } from '../ruh/ruh-facts.service.js';
import { RuhInsightsService } from '../ruh/ruh-insights.service.js';
import { RuhSettingsService } from '../ruh/ruh-settings.service.js';
import { RuhSignalService } from '../ruh/ruh-signal.service.js';
import { RuhWatchService, RUH_VAULT_CURSOR_ID } from '../ruh/ruh-watch.service.js';
import type { C3Signal } from '../ruh/ruh.contract.js';

const wrapped = postgres(TEST_DATABASE_URL, { max: 4, prepare: false, types: {}, onnotice: () => {} });
drizzle(wrapped);
const config = { get: () => undefined } as never;
const NOW = new Date();
const FORMULA_ID = randomUUID();
const FORMULA_CODE = `FRM-SECRET-${FORMULA_ID.slice(0, 6)}`;
let vaultAnswer: (() => unknown) | null = null;
const vaultApi = { ruhSync: async () => { if (!vaultAnswer) throw new Error('vault down'); return vaultAnswer(); } };
let watch: RuhWatchService;
let settings: RuhSettingsService;
const approverId = randomUUID();
const approverEmail = `approver-${approverId.slice(0, 6)}@rawaroma.test`;

const notes = async (key: string) => (await testClient()`select status, severity, title, body, prediction, resolved_at from platform.ruh_insight where dedupe_key = ${key} order by created_at`) as Array<Record<string, unknown>>;
const queued = async (key: string) => (await testClient()`select op, payload from bridge.ruh_signal where dedupe_key = ${key} and delivered_at is null order by seq`) as Array<{ op: string; payload: C3Signal | null }>;

before(async () => {
  await ensureSchema();
  await testClient()`delete from platform.ruh_insight`;
  await testClient()`delete from bridge.ruh_signal`;
  await testClient()`delete from platform.ruh_setting`;
  await testClient()`delete from bridge.vault_sync_cursor where id = ${RUH_VAULT_CURSOR_ID}`;
  await testClient()`insert into iam.user_master (user_id, user_name, email, is_active, status) values (${approverId}, 'approver', ${approverEmail}, true, 'ACTIVE')`;
  settings = new RuhSettingsService(wrapped);
  const signals = new RuhSignalService(wrapped, drizzle(wrapped, { schema: bridgeSchema }), config);
  const facts = new RuhFactsService(wrapped, signals, new ProduceQueueService(productionDb()), vaultApi as never);
  watch = new RuhWatchService(wrapped, settings, facts, new RuhInsightsService(wrapped, settings, signals), signals);
});
after(async () => {
  watch.onModuleDestroy();
  await wrapped.end();
  await closeTestClient();
});

test('a pass: real facts → notes (blocked with its fix, predicted late with its basis), mirrored; again → no change', async () => {
  vaultAnswer = () => ({ counts: { awaitingApproval: 2, recipesNeeded: 0, complianceWarnings: 0 }, overrides: [] });
  const p = await productWithSku();
  const blocked = await requirement({ sku: p.skuCode, rank: -500 });
  await testClient()`update bridge.production_requirement set produce_block_reason = 'QTY_NOT_IN_KG' where alembic_requirement_id = ${blocked.id}::uuid`;
  // 7 kg/day of recent output (98 kg in 14 days); 1000 kg needed in 2 days → late.
  const kg = await kgUom();
  const po = randomUUID();
  await testClient()`insert into production.production_order (production_order_id, order_qty, status) values (${po}, 98, 'COMPLETED')`;
  await testClient()`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, produced_qty, uom_id, produced_dt, status)
                     values (${randomUUID()}, ${po}, ${`W${po.slice(0, 6)}`}, 98, ${kg}, ${new Date(NOW.getTime() - 86_400_000).toISOString()}, 'RELEASED')`;
  const late = await requirement({ sku: p.skuCode, rank: -499, qtyKg: 100_000, neededBy: new Date(NOW.getTime() + 2 * 86_400_000).toISOString() });

  const run = await watch.runOnce(NOW);
  assert.ok(run.ran.includes('production') && run.ran.includes('vault'), JSON.stringify(run.failed));
  const [b] = await notes('production.blocked:QTY_NOT_IN_KG');
  assert.equal(b!.status, 'open');
  assert.match(String(b!.body), /Fix: Ask the sales system to resend the requirement in kg/);
  const [l] = await notes(`production.late:${late.id}`);
  assert.equal(l!.status, 'open');
  const pred = l!.prediction as { metric: string; basis: string; confidence: number };
  assert.equal(pred.metric, 'production_finish');
  assert.match(pred.basis, /kg still to make for this order and those ranked ahead of it, at \d+(\.\d)? kg a day/);
  assert.equal((await queued(`production.late:${late.id}`)).length, 1, 'mirrored to ALEMBIC');
  assert.equal((await notes('vault.recipes_awaiting_approval'))[0]!.status, 'open');

  const again = await watch.runOnce(NOW);
  assert.deepEqual({ opened: again.sync.opened, updated: again.sync.updated }, { opened: 0, updated: 0 });

  // The customer agrees a later date: the prediction no longer says late, the note clears and ALEMBIC is told.
  await testClient()`update bridge.production_requirement set needed_by = '2099-01-01T00:00:00Z' where alembic_requirement_id = ${late.id}::uuid`;
  await watch.runOnce(NOW);
  assert.equal((await notes(`production.late:${late.id}`))[0]!.status, 'done');
  assert.deepEqual((await queued(`production.late:${late.id}`)).map((q) => q.op), ['resolve']);
  await testClient()`update bridge.production_requirement set lifecycle_status = 'CANCELLED' where mapped_sku = ${p.skuCode}`;
});

test('a Vault override → an urgent admin note + a C3 override signal, once; no formula content leaves', async () => {
  const override = {
    seq: 41, overrideId: randomUUID(), action: 'vault.bulk_approve', actorId: approverId, reason: 'quarterly release, data follows',
    risks: [{ code: 'VAULT_BULK_APPROVE_CALC_WARNINGS', title: 'Approving 6 recipes at once while IFRA/allergen calculations show warnings', detail: '2 formulas of the 6 had an incomplete IFRA/allergen calculation (raw-material data missing). Result: 6 approved, 0 not approved.', severity: 'warn' }],
    createdAt: NOW.toISOString(),
  };
  vaultAnswer = () => ({ counts: { awaitingApproval: 0, recipesNeeded: 0, complianceWarnings: 0 }, overrides: [override] });
  const r1 = await watch.runOnce(NOW);
  assert.equal(r1.vaultOverrides, 1);
  const r2 = await watch.runOnce(NOW);
  assert.equal(r2.vaultOverrides, 0, 'the cursor moved: told once');
  const [note] = (await testClient()`select severity, audience_roles, console, deep_link, title, dedupe_key from platform.ruh_insight where kind = 'ruh.override' and console = 'vault'`) as Array<Record<string, unknown>>;
  assert.equal(note!.severity, 'urgent');
  assert.deepEqual(note!.audience_roles, ['owner', 'admin']);
  assert.equal(note!.deep_link, '#/review');
  assert.equal(note!.title, `${approverEmail} continued past a Ruh warning: approved many recipes at once in the Vault`);
  const [sig] = await queued(String(note!.dedupe_key));
  assert.equal(sig!.payload!.override!.actorEmail, approverEmail);
  assert.equal(sig!.payload!.override!.reason, 'quarterly release, data follows');
  const wire = JSON.stringify(sig!.payload);
  assert.ok(!wire.includes(FORMULA_ID) && !wire.includes(FORMULA_CODE), 'no formula id or code');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(JSON.stringify({ ...sig!.payload, dedupeKey: null })), 'no identifier of any kind (beyond the note\'s own key)');
  assert.equal((await notes('vault.recipes_awaiting_approval'))[0]!.status, 'done', 'the count dropped to zero: cleared');

  // An override whose reason names Vault details still alerts the admins, with the reason withheld.
  vaultAnswer = () => ({ counts: { awaitingApproval: 0, recipesNeeded: 0, complianceWarnings: 0 }, overrides: [{ ...override, seq: 42, reason: `checked ${FORMULA_ID} myself` }] });
  await watch.runOnce(NOW);
  const rows = (await testClient()`select payload from bridge.ruh_signal where payload->'override' is not null and payload->>'body' like '%Vault audit trail%'`) as Array<{ payload: C3Signal }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payload.override!.reason, 'The reason is kept in the Vault audit trail.');
  assert.ok(!JSON.stringify(rows[0]!.payload).includes(FORMULA_ID));
});

test('the Vault does not answer: its count notes stay; this box\'s own Vault notes are still checked', async () => {
  vaultAnswer = () => ({ counts: { awaitingApproval: 3, recipesNeeded: 1, complianceWarnings: 0 }, overrides: [] });
  await watch.runOnce(NOW);
  assert.equal((await notes('vault.recipes_needed')).at(-1)!.status, 'open');
  vaultAnswer = null;
  const run = await watch.runOnce(NOW);
  assert.ok(!run.ran.includes('vault'));
  assert.equal((await notes('vault.recipes_needed')).at(-1)!.status, 'open', 'kept as it was');
});

test('settings: 0 turns the timer off; "check now" still works', async () => {
  await settings.update({ 'watch.intervalSeconds': 0 }, principal({ userId: approverId }));
  const before = watch.status().lastRun?.at;
  (watch as unknown as { lastRunAt: number }).lastRunAt = 0;
  await watch.tick();
  assert.equal(watch.status().lastRun?.at, before, 'the timer did nothing');
  const r = await watch.runOnce(new Date(NOW.getTime() + 1000));
  assert.ok(r.ran.length > 0);
});
