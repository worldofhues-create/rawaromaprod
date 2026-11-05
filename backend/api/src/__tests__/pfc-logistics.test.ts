/**
 * Lane pf-c (plan section 6 station 6, section 9, 12.6): the logistics station and courier
 * connectors — floor-ops/logistics.service.ts, courier.service.ts — over the real packing station
 * and the real DispatchService.
 *
 *   all N cartons scanned (a carton of another shipment refused) before documents; documents fill
 *   only held fields (no invented invoice or e-way number); AWB non-empty, format-checked, never
 *   reused; handover makes one dispatch, records the documents, and Dispatched to ALEMBIC carries
 *   awb, courier and lots; exceptions re-book, send back to packing, or hold with an alert.
 *   Courier credentials are sealed and never returned; no live integration can be switched on.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient, principal, salesDb, packagingDb } from '../../../test-support/db.js';
import { DispatchService } from '../../../cluster-sales/src/dispatch/dispatch.service.js';
import { PackagingLookupService } from '../../../cluster-packaging/src/packaging-lookup.service.js';
import { DevicesService } from '../floor-ops/devices.service.js';
import { PrintService } from '../floor-ops/print.service.js';
import { ScaleService } from '../floor-ops/scale.service.js';
import { PackingService } from '../floor-ops/packing.service.js';
import { CourierService, type CourierAdapter } from '../floor-ops/courier.service.js';
import { LogisticsService } from '../floor-ops/logistics.service.js';

process.env.BRIDGE_HMAC_KEK ??= randomBytes(32).toString('base64');
let print: PrintService;
let packing: PackingService;
let couriers: CourierService;
let logistics: LogisticsService;
const user = principal({ userId: randomUUID(), roles: ['logistics'], permissions: ['sales:logistics:write', 'sales:dispatch_master:write'] });
const ST = 'Logistics 1';
const COURIER = `dlv${randomUUID().slice(0, 6)}`;

before(async () => {
  await ensureSchema();
  print = new PrintService(testClient(), new DevicesService(testClient()));
  packing = new PackingService(testClient(), print, new ScaleService(testClient()));
  couriers = new CourierService(testClient());
  logistics = new LogisticsService(testClient(), packing, couriers, print, new DispatchService(salesDb(), new PackagingLookupService(packagingDb())));
  await couriers.upsert(COURIER, { displayName: 'Delhivery', awbPattern: '\\d{13}', trackingUrlTemplate: 'https://www.delhivery.com/track/package/{awb}' }, user);
});
after(async () => closeTestClient());

const printAll = async (prefix: string) => {
  for (const j of await print.list({ status: 'browser', limit: 500 })) if ((j.subjectRef ?? '').startsWith(prefix)) await print.markBrowserPrinted(j.printJobId, user);
};

/** An order packed into two cartons, labels printed: ready for logistics. */
async function packed(opts: { dg?: boolean; amount?: number } = {}) {
  const sql = testClient();
  const so = randomUUID(), product = randomUUID(), sku = randomUUID(), fg = randomUUID(), cust = randomUUID();
  await sql`insert into sales.customer_master (customer_id, customer_code, customer_name, status) values (${cust}, ${'C-' + cust.slice(0, 6)}, 'Atelier Rose', 'ACTIVE')`;
  await sql`insert into sales.sales_order (sales_order_id, so_number, customer_id, order_date, total_amount, status) values (${so}, ${'SO-' + so.slice(0, 6)}, ${cust}, current_date, ${opts.amount ?? null}, 'CONFIRMED')`;
  await sql`insert into packaging.product_master (product_id, product_code, product_name, status) values (${product}, 'P', 'Oud', 'ACTIVE')`;
  await sql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status) values (${sku}, ${product}, 'SKU', '10 ml', 'ACTIVE')`;
  await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, product_sku_id, batch_number, produced_qty, status) values (${fg}, ${sku}, ${'FG-' + fg.slice(0, 6)}, 50, 'ACTIVE')`;
  await sql`insert into packaging.packaging_qc (packaging_qc_id, finished_good_batch_id, overall_result, status) values (${randomUUID()}, ${fg}, 'PASS', 'ACTIVE')`;
  if (opts.dg) await sql`insert into packaging.product_dg_info (product_dg_info_id, product_id, un_number, dg_class, packing_group, proper_shipping_name) values (${randomUUID()}, ${product}, '1266', '3', 'III', 'PERFUMERY PRODUCTS')`;
  const s = await packing.start({ salesOrderId: so, finishedGoodBatchIds: [fg] }, user);
  for (let i = 0; i < 2; i++) {
    const u = await packing.addUnit(s.shipmentId, { finishedGoodBatchId: fg, targetMg: 10_000, toleranceMg: 100, mg: 10_000, weightSource: 'typed', sealed: true }, ST, user);
    const c = await packing.openCarton(s.shipmentId, user);
    await packing.scanUnit(c.cartonId, u.unit.unitCode, user);
    await packing.closeCarton(c.cartonId, { mg: 60_000, weightSource: 'typed' }, ST, user);
  }
  await printAll(`U-${s.shipmentNo}`);
  await packing.finish(s.shipmentId, ST, user);
  await printAll(`CTN-${s.shipmentNo}`);
  return { ...(await packing.shipment(s.shipmentId)), fg, so };
}
const awb13 = () => String(Date.now()).padStart(13, '7').slice(-13);

test('the full carton set must be scanned; a carton of another shipment is refused', async () => {
  const a = await packed();
  const b = await packed();
  assert.ok((await logistics.queue()).some((q) => q.shipmentId === a.shipmentId));
  await assert.rejects(async () => logistics.documents(a.shipmentId, ST, user), /0 of 2 cartons/);
  await assert.rejects(async () => logistics.checkCarton(a.shipmentId, b.cartons[0]!.cartonCode, user), /another shipment/);
  const one = await logistics.checkCarton(a.shipmentId, a.cartons[0]!.cartonCode, user);
  assert.deepEqual([one.checked, one.total, one.complete], [1, 2, false]);
  await assert.rejects(async () => logistics.documents(a.shipmentId, ST, user), /1 of 2 cartons.*Missing/);
  assert.equal((await logistics.checkCarton(a.shipmentId, a.cartons[1]!.cartonCode, user)).complete, true);
});

test('documents: only fields we hold; no invented invoice or e-way number; DG only from sourced data', async () => {
  const a = await packed({ dg: true, amount: 75000 });
  for (const c of a.cartons) await logistics.checkCarton(a.shipmentId, c.cartonCode, user);
  const { docs } = await logistics.documents(a.shipmentId, ST, user);
  const inv = docs.find((d) => d.type === 'INVOICE')!;
  assert.equal(inv.documentNumber, null);
  assert.ok(inv.blanks.includes('invoiceNumber'));
  assert.equal(inv.fields.customer, 'Atelier Rose');
  const eway = docs.find((d) => d.type === 'EWAY_BILL')!;
  assert.equal(eway.documentNumber, null);
  assert.match(eway.note!, /Not determined/);
  const dg = docs.find((d) => d.type === 'DG_DECLARATION')!;
  assert.match(String(dg.fields.goods), /UN1266 · PERFUMERY PRODUCTS · Class 3 · PG III/);
  const plain = await packed();
  for (const c of plain.cartons) await logistics.checkCarton(plain.shipmentId, c.cartonCode, user);
  assert.ok(!(await logistics.documents(plain.shipmentId, ST, user)).docs.some((d) => d.type === 'DG_DECLARATION'));
});

async function docsReady() {
  const a = await packed();
  for (const c of a.cartons) await logistics.checkCarton(a.shipmentId, c.cartonCode, user);
  await logistics.documents(a.shipmentId, ST, user);
  return a;
}

test('AWB: non-empty, the courier\'s format, never reused', async () => {
  const a = await docsReady();
  const b = await docsReady();
  await assert.rejects(async () => logistics.assignAwb(a.shipmentId, { courierCode: COURIER, awb: '', source: 'scan' }, ST, user), /Scan or type/);
  await assert.rejects(async () => logistics.assignAwb(a.shipmentId, { courierCode: COURIER, awb: 'ABC123', source: 'scan' }, ST, user), /not a Delhivery AWB/);
  await assert.rejects(async () => logistics.assignAwb(a.shipmentId, { courierCode: 'nobody', awb: '1234567890123', source: 'typed' }, ST, user), /not in the courier list/);
  const awb = awb13();
  const r = await logistics.assignAwb(a.shipmentId, { courierCode: COURIER, awb, source: 'scan' }, ST, user);
  assert.equal(r.shipment.awb, awb);
  assert.equal(r.shipment.awbSource, 'scan');
  await assert.rejects(async () => logistics.assignAwb(b.shipmentId, { courierCode: COURIER, awb, source: 'typed' }, ST, user), /already used/);
});

test('handover: one dispatch, documents recorded, Dispatched to ALEMBIC carries awb, courier and lots', async () => {
  const a = await docsReady();
  const sql = testClient();
  // The order serves an ALEMBIC requirement through its production order.
  const order = randomUUID(), oil = randomUUID(), po = randomUUID(), req = randomUUID();
  await sql`insert into production.production_order (production_order_id, status) values (${order}, 'ACTIVE')`;
  await sql`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, status) values (${oil}, ${order}, ${'OB-' + oil.slice(0, 6)}, 'RELEASED')`;
  await sql`insert into packaging.package_order (package_order_id, oil_batch_id, status) values (${po}, ${oil}, 'ACTIVE')`;
  await sql`update packaging.finished_good_batch_master set package_order_id = ${po} where finished_good_batch_id = ${a.fg}`;
  await sql`insert into bridge.production_requirement (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, production_order_id)
    values (${req}, ${randomUUID()}, ${randomUUID()}, 'SO-LOG', 'SKU', 1, 'pc', now(), ${order})`;
  const awb = awb13().replace(/^./, '8');
  await logistics.assignAwb(a.shipmentId, { courierCode: COURIER, awb, source: 'typed' }, ST, user);
  await assert.rejects(async () => logistics.handover(a.shipmentId, {}, user), /name/);
  const done = await logistics.handover(a.shipmentId, { handedTo: 'Ravi (Delhivery)' }, user);
  assert.equal(done.status, 'HANDED_OVER');
  assert.equal(done.handedOverTo, 'Ravi (Delhivery)');
  assert.ok(done.dispatchId);
  const items = await sql`select dispatched_qty from sales.dispatch_items where dispatch_id = ${done.dispatchId}`;
  assert.equal(items.reduce((n, r) => n + Number(r.dispatched_qty), 0), 2);
  const docs = await sql`select document_type, document_number from sales.dispatch_document where dispatch_id = ${done.dispatchId} order by document_type`;
  assert.deepEqual(docs.map((d) => d.document_type), ['DELIVERY_CHALLAN', 'EWAY_BILL', 'INVOICE', 'PACKING_LIST']);
  assert.equal(docs.find((d) => d.document_type === 'INVOICE')!.document_number, null);
  const [ev] = await sql`select payload from bridge.outbox where type = 'Dispatched' and aggregate_id = ${req}`;
  const p = ev!.payload as Record<string, unknown>;
  const flat = JSON.stringify(p);
  assert.ok(flat.includes(awb), 'awb');
  assert.ok(flat.includes(`"courier":"${COURIER}"`), 'courier');
  assert.ok(flat.includes(`"carrier":"${COURIER}"`), 'carrier (the contract name)');
  assert.ok(flat.includes(a.units[0]!.batchNumber!), 'lots');
  await assert.rejects(async () => logistics.handover(a.shipmentId, { handedTo: 'again' }, user), /HANDED_OVER/);
});

test('exceptions: courier no-show re-books; damaged carton goes back to packing; address mismatch holds with an alert', async () => {
  const a = await docsReady();
  await logistics.assignAwb(a.shipmentId, { courierCode: COURIER, awb: awb13().replace(/^./, '9'), source: 'scan' }, ST, user);
  const rebook = await logistics.exception(a.shipmentId, { kind: 'COURIER_NO_SHOW' }, ST, user);
  assert.equal(rebook.status, 'DOCS_READY');
  assert.equal(rebook.awb, null);
  const held = await logistics.exception(a.shipmentId, { kind: 'ADDRESS_MISMATCH', note: 'pin 452001 vs 452010' }, ST, user);
  assert.equal(held.status, 'HOLD');
  const alerts = await testClient()`select title from platform.floor_alert where dedupe_key = ${'shipment_hold:' + a.shipmentId} and cleared_at is null`;
  assert.equal(alerts.length, 1);
  assert.equal((await logistics.exception(a.shipmentId, { kind: 'RELEASE_HOLD' }, ST, user)).status, 'DOCS_READY');
  const back = await logistics.exception(a.shipmentId, { kind: 'CARTON_DAMAGED', cartonCode: a.cartons[0]!.cartonCode }, ST, user);
  assert.equal(back.status, 'PACKING');
  assert.equal(back.cartons[0]!.status, 'OPEN');
});

test('courier connector: credentials sealed and never returned; no integration means it stays manual', async () => {
  const c = await couriers.connect(COURIER, { credentials: { apiKey: 'sk_live_SECRET123' } }, user);
  assert.equal(c.connected, true);
  assert.equal(c.health, 'no_adapter');
  assert.ok(!JSON.stringify(c).includes('SECRET123'));
  assert.ok(!JSON.stringify(await couriers.list()).includes('SECRET123'));
  const [row] = await testClient()`select credentials_sealed from sales.courier_connector where provider = ${COURIER}`;
  assert.ok(row!.credentials_sealed && !String(row!.credentials_sealed).includes('SECRET123'));
  await assert.rejects(async () => couriers.setMode(COURIER, 'live', user), /no live integration/i);
  await assert.rejects(async () => couriers.upsert(COURIER, { awbPattern: '(' }, user), /not a valid pattern/);
  const off = await couriers.disconnect(COURIER, user);
  assert.equal(off.connected, false);
});

test('courier connector with an adapter: test, turn on, and the scheduled sync tracks handed-over AWBs', async () => {
  const calls: string[][] = [];
  const adapter: CourierAdapter = {
    provider: 'fakeship',
    test: async (creds) => ({ ok: creds.apiKey === 'good' }),
    track: async (awbs) => { calls.push(awbs); return awbs.map((a) => ({ awb: a, status: 'IN_TRANSIT' })); },
  };
  const svc = new CourierService(testClient(), [adapter]);
  await testClient()`delete from sales.courier_connector where provider = 'fakeship'`;
  await svc.upsert('fakeship', { displayName: 'Fake Ship' }, user);
  await assert.rejects(async () => svc.setMode('fakeship', 'test', user), /Connect/);
  assert.equal((await svc.connect('fakeship', { credentials: { apiKey: 'bad' } }, user)).health, 'error');
  await assert.rejects(async () => svc.setMode('fakeship', 'test', user), /passing connection test/);
  assert.equal((await svc.connect('fakeship', { credentials: { apiKey: 'good' } }, user)).health, 'ok');
  assert.equal((await svc.setMode('fakeship', 'test', user)).mode, 'test');
  const synced = await svc.syncAll();
  assert.ok(synced.some((s) => s.provider === 'fakeship' && s.health === 'ok'));
  assert.equal(calls.length, 1);
  await svc.setMode('fakeship', 'off', user);
});
