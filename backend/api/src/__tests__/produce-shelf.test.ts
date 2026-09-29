/**
 * Lane produce — racks and the physical shelves. Real Postgres, the real ShelfLayoutService,
 * ShelfTaskService, PickLightService and BridgeRelayService (stubbed transport only).
 *
 *   layout     racks entered in the app: one quick entry makes a rack with its shelves and bins,
 *              a duplicate is refused, CSV import is idempotent; a scanned/typed code resolves.
 *   put-away   only QC-released FG; the target bin is assigned (same SKU's bin first); confirming
 *              at the shelf stocks the bin, closes the task and — in the same transaction — queues
 *              `fg.batch.received` {batch_no, sku, pack_size, qty_kg, rack, released_at} on the
 *              requirement's journey; the relay sends it as aggregate `fg_batch` with that journey's
 *              correlation id and org, metadata stripped. A quantity that cannot be expressed in kg
 *              is not sent, and says so (alert).
 *   lights     every assignment lights the bin (blue put-away / green pick), every completion turns
 *              it off; the simulator verifies the HMAC and shows lit bins; a controller receives
 *              exactly {task_id, rack, shelf, bin, qty, colour} signed over the raw body.
 *   picks      FIFO — oldest lot first — until the requirement's kg is covered; the wrong bin is
 *              refused; stock comes off the right one. Moves; the shelf display's counters; sheets
 *              in rack walking order.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { bridge as contracts } from '@core/contracts';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { BridgeRelayService } from '../bridge/relay.service.js';
import { sealSecret } from '../bridge/secret-box.js';
import { verifyBody } from '../bridge/signing.js';
import { shelfDb } from '../shelf/shelf.tokens.js';
import { ShelfLayoutService } from '../shelf/shelf-layout.service.js';
import { ShelfTaskService } from '../shelf/shelf-task.service.js';
import { PickLightService, PICK_LIGHT_SIGNATURE_HEADER } from '../shelf/pick-light.service.js';
import { ensureSchema, bridgeDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { finishedGood, productWithSku, rack, requirement, eachUom } from '../../../test-support/produce-fixtures.js';

const worker = principal({ userId: randomUUID(), roles: ['warehouse'] });
let layout: ShelfLayoutService;
let tasks: ShelfTaskService;
let lights: PickLightService;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  const db = shelfDb(testClient());
  layout = new ShelfLayoutService(db);
  lights = new PickLightService(db);
  tasks = new ShelfTaskService(db, layout, lights);
});
after(async () => {
  await testClient()`update location.pick_light_config set mode = 'off' where id = 'default'`;
  await closeTestClient();
});

const lightsFor = (taskId: string) =>
  testClient()`select action, body from location.pick_light_command where shelf_task_id = ${taskId} order by seq`;

test('layout: one quick entry makes a rack with shelves and bins; duplicates refused; CSV import is idempotent', async () => {
  const code = `Q${randomUUID().slice(0, 5).toUpperCase()}`;
  const zone = `ZQ${code}`;
  const made = await layout.quickRack({ zoneCode: zone, rackCode: code, shelves: 3, binsPerShelf: 4 }, worker);
  assert.equal(made.binCodes.length, 12);
  assert.equal(made.binCodes[0], `${code}-S1-B1`);
  assert.equal(made.binCodes[11], `${code}-S3-B4`);
  const [top] = await testClient()`select max(walk_seq)::int as max from location.rack_walk_order`;
  assert.equal(made.walkSeq, Number(top!.max), 'a new rack walks after every rack already laid out');
  await assert.rejects(() => layout.quickRack({ zoneCode: zone, rackCode: code, shelves: 1, binsPerShelf: 1 }, worker), ConflictException);
  const locs = await layout.locations(zone);
  assert.equal(locs.length, 12);
  assert.equal(locs[0]!.label, `${code}-S1-B1`);
  assert.equal((await layout.resolve(`${code.toLowerCase()}-s2-b3`)).binCode, `${code}-S2-B3`);

  const csvRack = `C${randomUUID().slice(0, 5).toUpperCase()}`;
  const csv = `zone,rack,shelf,bin,walk\n${zone},${csvRack},1,1,5\n${zone},${csvRack},1,2,5\n${zone},${csvRack},2,1\nbad line`;
  const first = await layout.importCsv(csv, worker);
  assert.equal(first.created, 3);
  assert.equal(first.errors.length, 1);
  const second = await layout.importCsv(csv, worker);
  assert.equal(second.created, 0);
  assert.equal(second.existing, 3);
  assert.equal((await layout.resolve(`${csvRack}-1-2`)).label, `${csvRack}-1-2`, 'short codes are prefixed with their parent');
  const walk = await testClient()`select w.walk_seq from location.rack_walk_order w join location.rack_master r on r.rack_id = w.rack_id where r.rack_code = ${csvRack}`;
  assert.equal(walk[0]!.walk_seq, 5);
});

test('put-away → fg.batch.received: exact payload on the requirement\'s journey; the relay sends it as fg_batch', async () => {
  const r1 = await rack();
  const product = await productWithSku({ packSize: '25 kg' });
  const orderId = randomUUID();
  await testClient()`insert into production.production_order (production_order_id, order_qty, status) values (${orderId}, 100, 'COMPLETED')`;
  const req = await requirement({ sku: product.skuCode, qtyKg: 100, productionOrderId: orderId });
  const fg = await finishedGood({ coa: 'RELEASED', product, productionOrderId: orderId, qty: 4 });

  const task = await tasks.ensurePutaway(fg.fgBatchId, worker, { binCode: r1.bins[1] });
  assert.equal(task.kind, 'PUTAWAY');
  assert.equal(task.label, r1.bins[1]);
  assert.equal(task.qty, 4);
  // Same request again returns the same open task (no duplicate).
  assert.equal((await tasks.ensurePutaway(fg.fgBatchId, worker)).shelfTaskId, task.shelfTaskId);

  const done = await tasks.completePutaway(task.shelfTaskId, r1.bins[1]!.toLowerCase(), worker);
  assert.equal(done.task.status, 'DONE');
  assert.equal(done.location, r1.bins[1]);
  assert.ok(done.fgBatchReceived.sent);
  const [stock] = await testClient()`select qty::float from location.fg_bin_stock where finished_good_batch_id = ${fg.fgBatchId}`;
  assert.equal(stock!.qty, 4);

  const rows = await testClient()`select id, payload from bridge.outbox where aggregate_id = ${fg.fgBatchId} and type = 'fg.batch.received'`;
  assert.equal(rows.length, 1);
  const stored = rows[0]!.payload as Record<string, unknown>;
  assert.deepEqual(stored, {
    batch_no: fg.fgBatchNo, sku: product.skuCode, pack_size: '25 kg', qty_kg: 100, rack: r1.bins[1],
    released_at: '2026-09-21T09:30:00.000Z', _correlation_id: req.correlationId, _org_id: req.orgId,
  });

  const relay = new BridgeRelayService(bridgeDb(), new ConfigService({ DATABASE_URL: 'postgres://apple@localhost:5432/unused', JWT_SECRET: 'x'.repeat(32) }));
  const SECRET = 'produce-shelf-relay-secret';
  await testClient()`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
            values ('default', true, 'https://alembic.example.test/in', ${sealSecret(SECRET)})
            on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url, hmac_secret_sealed = excluded.hmac_secret_sealed`;
  const sent: Array<{ headers: Record<string, string>; body: string }> = [];
  relay.fetchImpl = async (_u, init) => { sent.push({ headers: init!.headers as Record<string, string>, body: String(init!.body) }); return new Response('{"outcome":"applied"}', { status: 200 }); };
  for (let i = 0; i < 50 && !sent.some((s) => s.headers['x-bridge-event-id'] === rows[0]!.id); i++) await relay.drain();
  relay.onModuleDestroy();
  const ours = sent.find((s) => s.headers['x-bridge-event-id'] === rows[0]!.id)!;
  assert.ok(ours);
  assert.equal(verifyBody(ours.body, SECRET, ours.headers['x-bridge-signature']), true);
  const env = JSON.parse(ours.body);
  assert.equal(env.type, 'fg.batch.received');
  assert.deepEqual(env.aggregate, { type: 'fg_batch', id: fg.fgBatchId });
  assert.equal(env.correlation_id, req.correlationId);
  assert.equal(env.org_id, req.orgId);
  assert.deepEqual(env.payload, {
    batch_no: fg.fgBatchNo, sku: product.skuCode, pack_size: '25 kg', qty_kg: 100, rack: r1.bins[1], released_at: '2026-09-21T09:30:00.000Z',
  });
  assert.deepEqual(contracts.validateFgBatchReceived(env.payload), []);
});

test('put-away guards: unreleased FG is refused; the target is the same SKU\'s bin; a non-kg quantity is not sent and says so', async () => {
  const r = await rack();
  const pending = await finishedGood({ coa: 'TESTED_PASS' });
  await assert.rejects(() => tasks.ensurePutaway(pending.fgBatchId, worker), /not been released by QC/);

  const product = await productWithSku();
  const a = await finishedGood({ coa: 'RELEASED', product });
  const ta = await tasks.ensurePutaway(a.fgBatchId, worker, { binCode: r.bins[3] });
  await tasks.completePutaway(ta.shelfTaskId, r.bins[3]!, worker);
  const b = await finishedGood({ coa: 'RELEASED', product });
  const tb = await tasks.ensurePutaway(b.fgBatchId, worker);
  assert.equal(tb.label, r.bins[3], 'a SKU is kept together');

  const odd = await productWithSku({ packSize: '1 carton' });
  const c = await finishedGood({ coa: 'RELEASED', product: odd });
  const tc = await tasks.ensurePutaway(c.fgBatchId, worker, { binCode: r.bins[0] });
  const done = await tasks.completePutaway(tc.shelfTaskId, r.bins[0]!, worker);
  assert.equal(done.fgBatchReceived.sent, false);
  assert.equal((await testClient()`select 1 from bridge.outbox where aggregate_id = ${c.fgBatchId}`).length, 0);
  const alert = await testClient()`select kind from production.produce_alert where ref_id = ${c.fgBatchId}`;
  assert.deepEqual(alert.map((x) => x.kind), ['fg_received_not_sent']);
});

test('lights: on at assignment, off at completion; the simulator verifies the signature and shows lit bins', async () => {
  const r = await rack();
  await testClient()`insert into location.pick_light_config (id, mode) values ('default', 'off') on conflict (id) do update set mode = 'off'`;
  await lights.drain(); // flush whatever earlier suites queued
  await lights.configure({ mode: 'simulator' }, worker.userId);
  const fg = await finishedGood({ coa: 'RELEASED' });
  const t = await tasks.ensurePutaway(fg.fgBatchId, worker, { binCode: r.bins[2] });
  const queued = await lightsFor(t.shelfTaskId);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0]!.body, { task_id: t.shelfTaskId, rack: r.rackCode, shelf: `${r.rackCode}-S2`, bin: r.bins[2], qty: 4, colour: 'blue' });
  await lights.drain();
  const lit = (await lights.simulatorState([r.rackCode])) as Array<Record<string, unknown>>;
  assert.equal(lit.length, 1);
  assert.equal(lit[0]!.bin, r.bins[2]);
  assert.equal(lit[0]!.colour, 'blue');
  assert.equal(lit[0]!.signatureOk, true);
  const display = await tasks.display(r.zoneCode);
  assert.equal(display.counters.putawayTasks, 1);
  assert.equal(display.counters.putawayUnits, 4);
  assert.equal(display.lit.length, 1);

  await tasks.completePutaway(t.shelfTaskId, r.bins[2]!, worker);
  assert.deepEqual((await lightsFor(t.shelfTaskId)).map((l) => [l.action, (l.body as { colour: string }).colour, (l.body as { qty: number }).qty]),
    [['on', 'blue', 4], ['off', 'off', 0]]);
  await lights.drain();
  assert.equal(((await lights.simulatorState([r.rackCode])) as unknown[]).length, 0, 'the bin goes dark');
  assert.equal((await tasks.display(r.zoneCode)).counters.putawayTasks, 0);
});

test('lights: a controller receives exactly the six fields, HMAC-signed; http mode needs URL + secret', async () => {
  await testClient()`insert into location.pick_light_config (id, mode) values ('default', 'off')
                      on conflict (id) do update set mode = 'off', controller_url = null, hmac_secret_sealed = null`;
  await assert.rejects(() => lights.configure({ mode: 'http' }, worker.userId), /needs both/);
  await lights.drain();
  const SECRET = 'pick-light-controller-secret';
  await lights.configure({ mode: 'http', controllerUrl: 'https://lights.example.test/cmd', hmacSecret: SECRET }, worker.userId);
  const r = await rack();
  const { queued } = await lights.test(r.bins[0]!);
  const got: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  lights.fetchImpl = async (url, init) => { got.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) }); return new Response('ok', { status: 200 }); };
  const res = await lights.drain();
  assert.ok(res.sent >= 1);
  const mine = got.find((g) => JSON.parse(g.body).bin === r.bins[0])!;
  assert.equal(mine.url, 'https://lights.example.test/cmd');
  assert.deepEqual(JSON.parse(mine.body), { ...queued });
  assert.deepEqual(Object.keys(JSON.parse(mine.body)).sort(), ['bin', 'colour', 'qty', 'rack', 'shelf', 'task_id']);
  assert.equal(verifyBody(mine.body, SECRET, mine.headers[PICK_LIGHT_SIGNATURE_HEADER]), true);
  // A failing controller is retried, never dropped.
  await lights.test(r.bins[1]!);
  lights.fetchImpl = async () => new Response('down', { status: 503 });
  const failed = await lights.drain();
  assert.equal(failed.failed, 1);
  const [cmd] = await testClient()`select status, attempts, last_http_status from location.pick_light_command
                                    where body->>'bin' = ${r.bins[1]!} order by seq desc limit 1`;
  assert.deepEqual({ ...cmd }, { status: 'PENDING', attempts: 1, last_http_status: 503 });
  const status = await lights.status();
  assert.equal(status.mode, 'http');
  assert.equal(status.hasSecret, true);
  assert.equal('hmacSecretSealed' in status, false, 'the secret never comes back');
  await testClient()`update location.pick_light_config set mode = 'off' where id = 'default'`;
  await lights.drain();
});

test('picks: FIFO, oldest lot first, until the requirement\'s kg is covered; wrong bin refused; stock comes off', async () => {
  const r = await rack({ shelves: 1, bins: 3 });
  const product = await productWithSku({ packSize: '25 kg' });
  const old = await finishedGood({ coa: 'RELEASED', product, manufacturingDate: '2026-01-10', qty: 4 });
  const young = await finishedGood({ coa: 'RELEASED', product, manufacturingDate: '2026-06-10', qty: 4 });
  for (const [fg, bin] of [[young, r.bins[0]], [old, r.bins[2]]] as const) {
    const t = await tasks.ensurePutaway(fg.fgBatchId, worker, { binCode: bin });
    await tasks.completePutaway(t.shelfTaskId, bin!, worker);
  }
  const req = await requirement({ sku: product.skuCode, qtyKg: 150, rank: 1, reason: 'high_value' });
  assert.ok((await tasks.pickable()).some((p) => p.alembicRequirementId === req.id && p.highValue));
  const { tasks: picks, shortKg } = await tasks.createPicks(req.id, worker);
  assert.equal(shortKg, 0);
  assert.deepEqual(picks.map((p) => [p.batchNo, p.label, p.qty]), [[old.fgBatchNo, r.bins[2], 4], [young.fgBatchNo, r.bins[0], 2]],
    'the older lot is picked first, whole; the younger only for what is left');
  assert.ok(picks.every((p) => p.kind === 'PICK' && p.alembicRequirementId === req.id));
  assert.equal((await lightsFor(picks[0]!.shelfTaskId))[0]!.body.colour, 'green');
  await assert.rejects(() => tasks.createPicks(req.id, worker), /already fully picked/);
  assert.ok(!(await tasks.pickable()).some((p) => p.alembicRequirementId === req.id));

  await assert.rejects(() => tasks.completePick(picks[0]!.shelfTaskId, r.bins[0]!, worker), /Wrong bin: this pick is from/);
  await tasks.completePick(picks[0]!.shelfTaskId, r.bins[2]!, worker);
  const [left] = await testClient()`select qty::float from location.fg_bin_stock where finished_good_batch_id = ${old.fgBatchId}`;
  assert.equal(left!.qty, 0);

  const sheet = await tasks.sheet('PICK', r.zoneCode);
  assert.deepEqual(sheet.items.map((i) => i.shelfTaskId), [picks[1]!.shelfTaskId]);
  assert.match(sheet.items[0]!.qr, /^RAWTASK:/);
  assert.equal((await tasks.findByScan(sheet.items[0]!.qr)).shelfTaskId, picks[1]!.shelfTaskId);
  assert.equal((await tasks.findByScan(sheet.items[0]!.taskNo)).shelfTaskId, picks[1]!.shelfTaskId);
});

test('move, and sheets in rack walking order', async () => {
  const zone = `ZW${randomUUID().slice(0, 5).toUpperCase()}`;
  const far = await rack({ zoneCode: zone, walkSeq: 200, shelves: 1, bins: 1 });
  const near = await rack({ zoneCode: zone, walkSeq: 100, shelves: 1, bins: 1 });
  const uom = await eachUom();
  const a = await finishedGood({ coa: 'RELEASED', uomId: uom.id });
  const b = await finishedGood({ coa: 'RELEASED', uomId: uom.id });
  await tasks.ensurePutaway(a.fgBatchId, worker, { binCode: far.bins[0] });
  await tasks.ensurePutaway(b.fgBatchId, worker, { binCode: near.bins[0] });
  const sheet = await tasks.sheet('PUTAWAY', zone);
  assert.deepEqual(sheet.items.map((i) => i.label), [near.bins[0], far.bins[0]], 'the nearer rack in the walk comes first');

  const tb = sheet.items[0]!;
  await tasks.completePutaway(tb.shelfTaskId, near.bins[0]!, worker);
  const onBin = await tasks.binStock(near.bins[0]!.toLowerCase());
  assert.equal(onBin.bin.label, near.bins[0]);
  assert.deepEqual(onBin.items.map((i) => [i.finishedGoodBatchId, i.qty]), [[b.fgBatchId, 4]]);
  const moved = await tasks.move({ finishedGoodBatchId: b.fgBatchId, fromBinCode: near.bins[0]!, toBinCode: far.bins[0]!, qty: 1 }, worker);
  assert.equal(moved.task.kind, 'MOVE');
  assert.equal(moved.task.status, 'DONE');
  const stock = await testClient()`select b.bin_code, s.qty::float from location.fg_bin_stock s join location.bin_master b on b.bin_id = s.bin_id
                                    where s.finished_good_batch_id = ${b.fgBatchId} order by b.bin_code`;
  assert.deepEqual(stock.map((x) => [x.bin_code, x.qty]).sort(), [[far.bins[0], 1], [near.bins[0], 3]].sort());
  await assert.rejects(() => tasks.move({ finishedGoodBatchId: b.fgBatchId, fromBinCode: near.bins[0]!, toBinCode: far.bins[0]!, qty: 99 }, worker), /Move between/);
  const cancelled = await tasks.cancel(sheet.items[1]!.shelfTaskId, worker);
  assert.equal(cancelled.status, 'CANCELLED');
});
