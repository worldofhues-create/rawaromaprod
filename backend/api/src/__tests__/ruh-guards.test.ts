/**
 * Always-on Ruh — the guards on the factory's actions (ruh/ruh-guards.service.ts) and the
 * interceptor that enforces "warn, never block" on the server (ruh/ruh-guard.interceptor.ts).
 * Real Postgres on a Drizzle-wrapped pool; the route handler is a stand-in that records whether it ran.
 *
 * For every guard:
 *   - the risky case without a reason → 409 RUH_CONFIRM_REQUIRED with the risks, and the handler
 *     does NOT run; the error leaves AllExceptionsFilter as { code, message, details: { risks } };
 *   - a reason under 8 characters → still 409;
 *   - with a reason → the handler runs (ruhOverride taken off the body first), then the override is
 *     audited, an urgent note goes to owner/admin and a C3 signal with `override` is queued;
 *   - the safe case → the handler runs, nothing is recorded.
 * And: a failed action records no override; a check that cannot be worked out never blocks.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lastValueFrom, of, throwError } from 'rxjs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as bridgeSchema from '@ra/data-bridge';
import { ensureSchema, testClient, closeTestClient, TEST_DATABASE_URL, principal } from '../../../test-support/db.js';
import { finishedGood, productWithSku, rack, requirement } from '../../../test-support/produce-fixtures.js';
import { AllExceptionsFilter } from '../../../backend-kernel/src/edge/all-exceptions.filter.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { RuhGuardInterceptor } from '../ruh/ruh-guard.interceptor.js';
import { RuhGuardsService } from '../ruh/ruh-guards.service.js';
import { RuhInsightsService } from '../ruh/ruh-insights.service.js';
import { RuhSettingsService } from '../ruh/ruh-settings.service.js';
import { RuhSignalService } from '../ruh/ruh-signal.service.js';
import type { C3Signal, Risk } from '../ruh/ruh.contract.js';

const wrapped = postgres(TEST_DATABASE_URL, { max: 3, prepare: false, types: {}, onnotice: () => {} });
drizzle(wrapped);
let env: Record<string, string | undefined> = {};
const config = { get: (k: string) => env[k] } as never;
let settings: RuhSettingsService;
let guards: RuhGuardsService;
let interceptor: RuhGuardInterceptor;
const actor = principal({ userId: randomUUID(), roles: ['production', 'warehouse', 'qc'], permissions: [] });
const ACTOR_EMAIL = `guard-${actor.userId.slice(0, 6)}@rawaroma.test`;

interface Outcome { ran: boolean; body: Record<string, unknown>; error?: DomainError; result?: unknown }

/** Run one request through the interceptor; the "handler" records that it ran and what body it saw. */
async function call(method: string, url: string, params: Record<string, string>, body: Record<string, unknown>, handler?: () => unknown): Promise<Outcome> {
  const req = { method, routeOptions: { url }, params, body: { ...body }, user: actor };
  const out: Outcome = { ran: false, body: req.body };
  const ctx = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as never;
  try {
    out.result = await lastValueFrom(interceptor.intercept(ctx, {
      handle: () => { out.ran = true; out.body = { ...req.body }; return handler ? (handler() as never) : of({ ok: true }); },
    }));
  } catch (e) {
    if (e instanceof DomainError) out.error = e; else throw e;
  }
  return out;
}

const overridesFor = async (guard: string) => (await testClient()`
  select after from platform.audit_events where action = 'ruh.override' and after->>'guard' = ${guard} order by occurred_at`) as Array<{ after: Record<string, unknown> }>;
const lastSignal = async () => ((await testClient()`select payload from bridge.ruh_signal where dedupe_key like 'override:%' order by seq desc limit 1`) as Array<{ payload: C3Signal }>)[0]?.payload;

/** The three-way check every guard gets: 409 without (or with a too-short) reason, proceeds + recorded with one. */
async function assertWarnsThenProceeds(method: string, url: string, params: Record<string, string>, body: Record<string, unknown>, guard: string, code: string): Promise<Risk[]> {
  const before = (await overridesFor(guard)).length;
  const no = await call(method, url, params, body);
  assert.equal(no.ran, false, `${guard}: the handler must not run without a reason`);
  assert.equal(no.error?.code, 'RUH_CONFIRM_REQUIRED');
  assert.equal(no.error?.status, 409);
  const risks = (no.error!.details as { risks: Risk[] }).risks;
  assert.ok(risks.some((r) => r.code === code), `${guard}: expected risk ${code}, got ${risks.map((r) => r.code).join(', ')}`);
  assert.equal((no.error!.details as { action: string }).action, guard);

  const short = await call(method, url, params, { ...body, ruhOverride: { reason: 'ok' } });
  assert.equal(short.ran, false);
  assert.match(short.error!.message, /at least 8 characters/);

  const yes = await call(method, url, params, { ...body, ruhOverride: { reason: '  the customer is collecting today  ' } });
  assert.equal(yes.ran, true, `${guard}: a reason always lets a Ruh warning through`);
  assert.ok(!('ruhOverride' in yes.body), 'ruhOverride never reaches the handler (strict DTOs stay strict)');
  const recorded = await overridesFor(guard);
  assert.equal(recorded.length, before + 1);
  assert.equal(recorded[recorded.length - 1]!.after.reason, 'the customer is collecting today');
  const sig = await lastSignal();
  assert.equal(sig!.override!.reason, 'the customer is collecting today');
  assert.equal(sig!.override!.actorEmail, ACTOR_EMAIL);
  assert.ok(sig!.override!.risks.some((r) => r.code === code));
  assert.equal(sig!.severity, 'urgent');
  assert.deepEqual(sig!.audienceRoles, ['admin']);
  return risks;
}

async function assertQuiet(method: string, url: string, params: Record<string, string>, body: Record<string, unknown>, guard: string) {
  const before = (await overridesFor(guard)).length;
  const r = await call(method, url, params, { ...body, ruhOverride: { reason: 'not needed at all' } });
  assert.equal(r.error, undefined, `${guard}: no risk, no warning (${r.error?.message})`);
  assert.equal(r.ran, true);
  assert.equal((await overridesFor(guard)).length, before, 'no risk, nothing recorded');
}

before(async () => {
  await ensureSchema();
  await testClient()`insert into iam.user_master (user_id, user_name, email, is_active, status) values (${actor.userId}, 'guard', ${ACTOR_EMAIL}, true, 'ACTIVE')`;
  settings = new RuhSettingsService(wrapped);
  const signals = new RuhSignalService(wrapped, drizzle(wrapped, { schema: bridgeSchema }), config);
  guards = new RuhGuardsService(wrapped, settings, config);
  interceptor = new RuhGuardInterceptor(guards, new RuhInsightsService(wrapped, settings, signals));
});
beforeEach(async () => {
  env = {};
  await testClient()`delete from platform.ruh_setting`;
  (settings as unknown as { cache: unknown }).cache = null;
});
after(async () => {
  await wrapped.end();
  await closeTestClient();
});

test('the 409 leaves the API as { code: RUH_CONFIRM_REQUIRED, message, details: { risks, action } }', () => {
  const sent: { status?: number; body?: unknown } = {};
  const reply = { status(c: number) { sent.status = c; return reply; }, send(b: unknown) { sent.body = b; } };
  const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ method: 'POST', url: '/v1/x', requestId: 'r1' }) }) } as never;
  const risks = [{ code: 'X', title: 'T', detail: 'D', severity: 'warn' }];
  new AllExceptionsFilter().catch(new DomainError('RUH_CONFIRM_REQUIRED', 'Ruh has a warning', 409, { risks, action: 'a' }), host);
  assert.equal(sent.status, 409);
  const err = (sent.body as { error: { code: string; details: { risks: unknown } } }).error;
  assert.equal(err.code, 'RUH_CONFIRM_REQUIRED');
  assert.deepEqual(err.details.risks, risks);
});

test('plan out of order: a higher-ranked order is still waiting → warn; the top of the queue → quiet', async () => {
  const p = await productWithSku();
  // Ranks below anything already in the shared test database, so this test owns the head of the queue.
  const [{ low }] = await testClient()`select coalesce(min(priority_rank), 0)::int - 10 as low from bridge.production_requirement` as unknown as [{ low: number }];
  await requirement({ sku: p.skuCode, rank: low + 1, reason: 'high_value', valueInr: 90_000 });
  const target = await requirement({ sku: p.skuCode, rank: low + 2 });
  const risks = await assertWarnsThenProceeds('POST', '/v1/produce/requirements/:id/plan', { id: target.id }, {}, 'production.plan_out_of_order', 'HIGHER_PRIORITY_WAITING');
  assert.equal(risks[0]!.severity, 'urgent', 'a high-value order is among those waiting');
  assert.match(risks[0]!.detail, /high value/);
  const top = await requirement({ sku: p.skuCode, rank: low });
  await assertQuiet('POST', '/v1/produce/requirements/:id/plan', { id: top.id }, {}, 'production.plan_out_of_order');
  // Leave the shared queue as other files expect it: these three are this test's own.
  await testClient()`update bridge.production_requirement set lifecycle_status = 'CANCELLED' where mapped_sku = ${p.skuCode}`;
});

test('pick out of FIFO: an older released batch of the same SKU is free on a shelf → warn; picking the oldest → quiet', async () => {
  const p = await productWithSku();
  const r = await rack({ shelves: 1, bins: 2 });
  const old = await finishedGood({ product: p, manufacturingDate: '2026-08-01' });
  const fresh = await finishedGood({ product: p, manufacturingDate: '2026-09-25' });
  for (const [fg, bin] of [[old.fgBatchId, r.bins[0]!], [fresh.fgBatchId, r.bins[1]!]] as const) {
    await testClient()`insert into location.fg_bin_stock (finished_good_batch_id, bin_id, qty, put_away_dt, status)
                       select ${fg}::uuid, bin_id, 4, now(), 'ACTIVE' from location.bin_master where bin_code = ${bin}`;
  }
  const risks = await assertWarnsThenProceeds('POST', '/v1/shelf/picks', {}, { finishedGoodBatchId: fresh.fgBatchId, binCode: r.bins[1], qty: 1 }, 'shelf.pick_out_of_fifo', 'PICK_NOT_FIFO');
  assert.match(risks[0]!.detail, new RegExp(`Batch ${old.fgBatchNo} \\(made 2026-08-01\\)`));
  await assertQuiet('POST', '/v1/shelf/picks', {}, { finishedGoodBatchId: old.fgBatchId, qty: 1 }, 'shelf.pick_out_of_fifo');
});

test('put-away / move: a bin holding another SKU, or over its batch limit → warn; an empty bin → quiet', async () => {
  const r = await rack({ shelves: 1, bins: 3 });
  const other = await finishedGood();
  await testClient()`insert into location.fg_bin_stock (finished_good_batch_id, bin_id, qty, put_away_dt, status)
                     select ${other.fgBatchId}::uuid, bin_id, 4, now(), 'ACTIVE' from location.bin_master where bin_code = ${r.bins[0]!}`;
  const mine = await finishedGood();
  const task = (await testClient()`insert into location.shelf_task (kind, finished_good_batch_id, qty, status)
                                   values ('PUTAWAY', ${mine.fgBatchId}, 4, 'OPEN') returning shelf_task_id::text as id`)[0]!.id as string;
  await assertWarnsThenProceeds('POST', '/v1/shelf/tasks/:id/putaway', { id: task }, { binCode: r.bins[0] }, 'shelf.putaway_mixed_or_full', 'BIN_HOLDS_OTHER_SKU');
  await assertWarnsThenProceeds('POST', '/v1/shelf/putaway', {}, { finishedGoodBatchId: mine.fgBatchId, binCode: r.bins[0] }, 'shelf.putaway_mixed_or_full', 'BIN_HOLDS_OTHER_SKU');
  await assertQuiet('POST', '/v1/shelf/tasks/:id/putaway', { id: task }, { binCode: r.bins[1] }, 'shelf.putaway_mixed_or_full');
  // Over the limit: the setting is 1 batch per bin, the bin already holds one (of the same SKU).
  const same = await finishedGood({ product: { productId: other.productId, productCode: other.productCode, productName: other.productName, formulaId: other.formulaId, skuId: other.skuId, skuCode: other.skuCode, packSize: other.packSize } });
  await settings.update({ 'shelf.binMaxBatches': 1 }, actor);
  const risks = await assertWarnsThenProceeds('POST', '/v1/shelf/move', {}, { finishedGoodBatchId: same.fgBatchId, fromBinCode: r.bins[2], toBinCode: r.bins[0], qty: 1 }, 'shelf.putaway_mixed_or_full', 'BIN_OVER_CAPACITY');
  assert.ok(!risks.some((x) => x.code === 'BIN_HOLDS_OTHER_SKU'), 'same SKU: only the limit');
});

test('COA release at the edge of the spec → warn (it still passes); comfortably inside → quiet; a failed COA is the service\'s own refusal', async () => {
  const edge = await finishedGood({ coa: 'TESTED_PASS' }); // flash point 116 in 110–120 → 40 % away; SG 0.995 in 0.95–1.5 → 8 %
  await assertQuiet('POST', '/v1/batch-coas/:id/release', { id: edge.batchCoaId! }, {}, 'qc.release_at_spec_edge');
  await testClient()`update production.batch_coa set flash_point_result_c = 119.8 where batch_coa_id = ${edge.batchCoaId!}::uuid`;
  const risks = await assertWarnsThenProceeds('POST', '/v1/batch-coas/:id/release', { id: edge.batchCoaId! }, {}, 'qc.release_at_spec_edge', 'COA_FLASH_POINT_AT_EDGE');
  assert.match(risks[0]!.detail, /Flash point 119\.8 °C is within 2% of the upper limit 120 °C \(spec 110–120 °C; Ruh flags within 5%\)/);
  await settings.update({ 'guard.coaEdgeMarginPct': 10 }, actor);
  const r2 = await call('POST', '/v1/batch-coas/:id/release', { id: edge.batchCoaId! }, {});
  assert.ok((r2.error!.details as { risks: Risk[] }).risks.some((x) => x.code === 'COA_SG_AT_EDGE'), 'SG at 8 % is an edge once the margin is 10 %');
  const failed = await finishedGood({ coa: 'TESTED_FAIL' });
  await assertQuiet('POST', '/v1/batch-coas/:id/release', { id: failed.batchCoaId! }, {}, 'qc.release_at_spec_edge');
});

test('editing / removing a rack, shelf or bin that holds stock → warn (urgent when taking it out of use); an empty one → quiet', async () => {
  const r = await rack({ shelves: 1, bins: 2 });
  const fg = await finishedGood();
  await testClient()`insert into location.fg_bin_stock (finished_good_batch_id, bin_id, qty, put_away_dt, status)
                     select ${fg.fgBatchId}::uuid, bin_id, 4, now(), 'ACTIVE' from location.bin_master where bin_code = ${r.bins[0]!}`;
  const ids = (await testClient()`select b.bin_id::text as bin, b.shelf_id::text as shelf, s.rack_id::text as rack
                                   from location.bin_master b join location.shelf_master s on s.shelf_id = b.shelf_id where b.bin_code in ${testClient()([r.bins[0]!, r.bins[1]!])} order by b.bin_code`) as Array<{ bin: string; shelf: string; rack: string }>;
  const risks = await assertWarnsThenProceeds('PATCH', '/v1/masters/:resource/:id', { resource: 'racks', id: ids[0]!.rack }, { status: 'INACTIVE' }, 'location.edit_stocked', 'LOCATION_REMOVE_WITH_STOCK');
  assert.equal(risks[0]!.severity, 'urgent');
  await assertWarnsThenProceeds('PATCH', '/v1/masters/:resource/:id', { resource: 'bins', id: ids[0]!.bin }, { binName: 'New name' }, 'location.edit_stocked', 'LOCATION_EDIT_WITH_STOCK');
  await assertQuiet('PATCH', '/v1/masters/:resource/:id', { resource: 'bins', id: ids[1]!.bin }, { status: 'INACTIVE' }, 'location.edit_stocked');
  await assertQuiet('PATCH', '/v1/masters/:resource/:id', { resource: 'materials', id: randomUUID() }, { status: 'INACTIVE' }, 'location.edit_stocked');
});

test('pick-to-light off / simulator in production → warn; outside production (by default) or unchanged → quiet', async () => {
  await testClient()`insert into location.pick_light_config (id, mode) values ('default', 'http') on conflict (id) do update set mode = 'http'`;
  await assertQuiet('PUT', '/v1/shelf/pick-light/config', {}, { mode: 'off' }, 'shelf.pick_light_off');
  env = { APP_ENV: 'prod', RAWPROD_ENVIRONMENT: 'production' };
  await assertWarnsThenProceeds('PUT', '/v1/shelf/pick-light/config', {}, { mode: 'off' }, 'shelf.pick_light_off', 'PICK_LIGHT_OFF_IN_PRODUCTION');
  await assertWarnsThenProceeds('PUT', '/v1/shelf/pick-light/config', {}, { mode: 'simulator' }, 'shelf.pick_light_off', 'PICK_LIGHT_SIMULATOR_IN_PRODUCTION');
  await assertQuiet('PUT', '/v1/shelf/pick-light/config', {}, { mode: 'http', controllerUrl: 'https://x' }, 'shelf.pick_light_off');
  env = {};
  await settings.update({ 'guard.pickLightProductionOnly': false }, actor);
  const r = await call('PUT', '/v1/shelf/pick-light/config', {}, { mode: 'simulator' });
  assert.equal(r.error?.code, 'RUH_CONFIRM_REQUIRED', 'the setting extends the warning to every deployment');
  await testClient()`update location.pick_light_config set mode = 'off' where id = 'default'`;
});

test('changing a product\'s formula → warn (urgent with open orders); a first link or the same formula → quiet', async () => {
  const p = await productWithSku();
  const risks = await assertWarnsThenProceeds('POST', '/v1/products/:id/formula-link', { id: p.productId }, { formulaId: randomUUID(), reason: 'swap' }, 'formula.link_change', 'FORMULA_LINK_REPLACED');
  assert.ok(!risks.some((r) => r.code === 'FORMULA_LINK_WITH_OPEN_WORK'));
  await requirement({ sku: p.skuCode });
  const r = await call('POST', '/v1/products/:id/formula-link', { id: p.productId }, { formulaId: randomUUID(), reason: 'swap' });
  assert.ok((r.error!.details as { risks: Risk[] }).risks.some((x) => x.code === 'FORMULA_LINK_WITH_OPEN_WORK' && x.severity === 'urgent'));
  await assertQuiet('POST', '/v1/products/:id/formula-link', { id: p.productId }, { formulaId: p.formulaId, reason: 'same' }, 'formula.link_change');
  const fresh = await productWithSku({ formulaId: null });
  await assertQuiet('POST', '/v1/products/:id/formula-link', { id: fresh.productId }, { formulaId: randomUUID(), reason: 'first link' }, 'formula.link_change');
});

test('a failed action records no override; an unguarded route and an unauthenticated request are untouched', async () => {
  const p = await productWithSku();
  const before = (await overridesFor('formula.link_change')).length;
  const r = await call('POST', '/v1/products/:id/formula-link', { id: p.productId }, { formulaId: randomUUID(), reason: 'x', ruhOverride: { reason: 'going ahead anyway' } },
    () => throwError(() => new DomainError('NOT_FOUND', 'No such formula in the Vault.', 404)));
  assert.equal(r.error?.code, 'NOT_FOUND', 'the service\'s own refusal stands');
  assert.equal((await overridesFor('formula.link_change')).length, before, 'nothing was overridden');
  const u = await call('POST', '/v1/purchase-orders', {}, { ruhOverride: { reason: 'irrelevant here' } });
  assert.equal(u.ran, true);
  assert.ok('ruhOverride' in u.body, 'an unguarded route\'s body is not touched');
});

test('a check that cannot be worked out never blocks', async () => {
  const broken = new RuhGuardsService(wrapped, settings, config);
  (broken as unknown as { guards: unknown[] }).guards = [{ action: 'x.broken', method: 'POST', route: '/v1/x', check: async () => { throw new Error('db down'); } }];
  const i = new RuhGuardInterceptor(broken, new RuhInsightsService(wrapped, settings, new RuhSignalService(wrapped, drizzle(wrapped, { schema: bridgeSchema }), config)));
  const req = { method: 'POST', routeOptions: { url: '/v1/x' }, params: {}, body: {}, user: actor };
  let ran = false;
  await lastValueFrom(i.intercept({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as never, { handle: () => { ran = true; return of(1); } }));
  assert.ok(ran);
});
