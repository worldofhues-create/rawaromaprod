/**
 * Lane pf-c (plan section 6, station 5): the packing station — floor-ops/packing.service.ts.
 * Only a QC-approved, non-macerating lot is packed; each unit is weighed within tolerance (exact
 * mg), sealed, and gets the branded customer label; units are scanned into cartons, and a unit of
 * another order or lot is refused; a carton is weighed; finishing prints "carton i of N" labels and
 * the packing list, and needs every customer label printed. Hazard text only from sourced data.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient, principal } from '../../../test-support/db.js';
import { DevicesService } from '../floor-ops/devices.service.js';
import { PrintService } from '../floor-ops/print.service.js';
import { ScaleService } from '../floor-ops/scale.service.js';
import { PackingService } from '../floor-ops/packing.service.js';

let print: PrintService;
let packing: PackingService;
const packer = principal({ userId: randomUUID(), roles: ['packing'], permissions: ['packaging:packing_station:write'] });
const STATION = 'Packing 1';

before(async () => {
  await ensureSchema();
  const devices = new DevicesService(testClient());
  print = new PrintService(testClient(), devices);
  packing = new PackingService(testClient(), print, new ScaleService(testClient()));
});
after(async () => closeTestClient());

async function order() {
  const id = randomUUID();
  await testClient()`insert into sales.sales_order (sales_order_id, so_number, status) values (${id}, ${'SO-' + id.slice(0, 6)}, 'CONFIRMED')`;
  return id;
}
async function fgLot(opts: { qc?: string | null; dg?: boolean } = {}) {
  const sql = testClient();
  const product = randomUUID(), sku = randomUUID(), fg = randomUUID();
  await sql`insert into packaging.product_master (product_id, product_code, product_name, status) values (${product}, ${'P-' + product.slice(0, 4)}, 'Oud Noir EDP', 'ACTIVE')`;
  await sql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status) values (${sku}, ${product}, ${'SKU-' + sku.slice(0, 4)}, '100 ml', 'ACTIVE')`;
  await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, product_sku_id, batch_number, produced_qty, status) values (${fg}, ${sku}, ${'FG-' + fg.slice(0, 6)}, 50, 'ACTIVE')`;
  if (opts.qc !== null) await sql`insert into packaging.packaging_qc (packaging_qc_id, finished_good_batch_id, overall_result, status) values (${randomUUID()}, ${fg}, ${opts.qc ?? 'PASS'}, 'ACTIVE')`;
  if (opts.dg) await sql`insert into packaging.product_dg_info (product_dg_info_id, product_id, un_number, dg_class, packing_group) values (${randomUUID()}, ${product}, '1266', '3', 'III')`;
  return fg;
}
const unitBody = (fg: string, mg = 100_000) => ({ finishedGoodBatchId: fg, targetMg: 100_000, toleranceMg: 1_000, mg, weightSource: 'typed', sealed: true });
async function printAll(subject: string) {
  for (const j of await print.list({ subjectRef: subject })) if (j.status !== 'printed') await print.markBrowserPrinted(j.printJobId, packer);
}

test('start: only QC-approved lots are packed', async () => {
  const so = await order();
  await assert.rejects(async () => packing.start({ salesOrderId: so, finishedGoodBatchIds: [await fgLot({ qc: null })] }, packer), /QC/);
  await assert.rejects(async () => packing.start({ salesOrderId: so, finishedGoodBatchIds: [await fgLot({ qc: 'FAIL' })] }, packer), /QC/);
  await assert.rejects(async () => packing.start({ salesOrderId: randomUUID(), finishedGoodBatchIds: [await fgLot()] }, packer), /order/i);
  const s = await packing.start({ salesOrderId: so, finishedGoodBatchIds: [await fgLot()] }, packer);
  assert.equal(s.status, 'PACKING');
  assert.match(s.shipmentNo, /^SHP-/);
});

test('unit: weight within tolerance (exact mg), sealed; the branded customer label is queued', async () => {
  const so = await order();
  const fg = await fgLot();
  const s = await packing.start({ salesOrderId: so, finishedGoodBatchIds: [fg] }, packer);
  await assert.rejects(async () => packing.addUnit(s.shipmentId, unitBody(fg, 101_001), STATION, packer), /tolerance/);
  await assert.rejects(async () => packing.addUnit(s.shipmentId, { ...unitBody(fg), sealed: false }, STATION, packer), /seal/);
  await assert.rejects(async () => packing.addUnit(s.shipmentId, unitBody(await fgLot()), STATION, packer), /not one of this shipment's lots/);
  const u = await packing.addUnit(s.shipmentId, unitBody(fg, 101_000), STATION, packer);
  assert.equal(u.unit.weightSource, 'typed');
  assert.equal(u.unit.netMg, 101_000);
  const t = u.label.template;
  const text = t.elements.map((e) => e.s ?? e.d).join(' | ');
  assert.match(text, /RAW AROMA CHEM/);
  assert.match(text, /Oud Noir EDP/);
  assert.match(text, /100 ml/);
  assert.match(text, /FG-/);
  assert.match(text, /QC: APPROVED/);
  assert.match(text, /Hazard: Classification pending/, 'no sourced DG data -> never asserted as safe');
  assert.ok(t.elements.some((e) => e.t === 'code128' && e.d === u.unit.unitCode));
});

test('hazard line comes only from the product\'s sourced DG record', async () => {
  const so = await order();
  const fg = await fgLot({ dg: true });
  const s = await packing.start({ salesOrderId: so, finishedGoodBatchIds: [fg] }, packer);
  const u = await packing.addUnit(s.shipmentId, unitBody(fg), STATION, packer);
  assert.match(u.label.template.elements.map((e) => e.s).join(' '), /UN1266 · Class 3 · PG III/);
});

test('cartons: a unit of another order or another lot is refused; a unit cannot go in twice', async () => {
  const soA = await order(), soB = await order();
  const fgA = await fgLot(), fgB = await fgLot();
  const a = await packing.start({ salesOrderId: soA, finishedGoodBatchIds: [fgA] }, packer);
  const a2 = await packing.start({ salesOrderId: soA, finishedGoodBatchIds: [fgB] }, packer);
  const b = await packing.start({ salesOrderId: soB, finishedGoodBatchIds: [fgB] }, packer);
  const ua = await packing.addUnit(a.shipmentId, unitBody(fgA), STATION, packer);
  const uOtherLot = await packing.addUnit(a2.shipmentId, unitBody(fgB), STATION, packer);
  const uOtherOrder = await packing.addUnit(b.shipmentId, unitBody(fgB), STATION, packer);
  const c = await packing.openCarton(a.shipmentId, packer);
  await assert.rejects(async () => packing.scanUnit(c.cartonId, uOtherOrder.unit.unitCode, packer), /another order/);
  await assert.rejects(async () => packing.scanUnit(c.cartonId, uOtherLot.unit.unitCode, packer), /lot/);
  await assert.rejects(async () => packing.scanUnit(c.cartonId, 'U-NOPE', packer), /not found/);
  await packing.scanUnit(c.cartonId, ua.unit.unitCode, packer);
  await assert.rejects(async () => packing.scanUnit(c.cartonId, ua.unit.unitCode, packer), /already/);
});

test('carton weight: never lighter than its contents, nor beyond the packaging allowance', async () => {
  const so = await order();
  const fg = await fgLot();
  const s = await packing.start({ salesOrderId: so, finishedGoodBatchIds: [fg] }, packer);
  const u = await packing.addUnit(s.shipmentId, unitBody(fg), STATION, packer);
  const c = await packing.openCarton(s.shipmentId, packer);
  await assert.rejects(async () => packing.closeCarton(c.cartonId, { mg: 150_000, weightSource: 'typed' }, STATION, packer), /no units/);
  await packing.scanUnit(c.cartonId, u.unit.unitCode, packer);
  await assert.rejects(async () => packing.closeCarton(c.cartonId, { mg: 99_000, weightSource: 'typed' }, STATION, packer), /lighter/);
  await assert.rejects(async () => packing.closeCarton(c.cartonId, { mg: 5_000_000, weightSource: 'typed', allowanceMg: 500_000 }, STATION, packer), /allowance/);
  const closed = await packing.closeCarton(c.cartonId, { mg: 180_000, weightSource: 'typed' }, STATION, packer);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.grossMg, 180_000);
});

test('finish: needs every unit in a closed carton and its label printed; prints carton i of N and the packing list', async () => {
  const so = await order();
  const fg = await fgLot();
  const s = await packing.start({ salesOrderId: so, finishedGoodBatchIds: [fg] }, packer);
  const u1 = await packing.addUnit(s.shipmentId, unitBody(fg), STATION, packer);
  const u2 = await packing.addUnit(s.shipmentId, unitBody(fg), STATION, packer);
  const c1 = await packing.openCarton(s.shipmentId, packer);
  await packing.scanUnit(c1.cartonId, u1.unit.unitCode, packer);
  await assert.rejects(async () => packing.openCarton(s.shipmentId, packer), /open/);
  await packing.closeCarton(c1.cartonId, { mg: 150_000, weightSource: 'typed' }, STATION, packer);
  await assert.rejects(async () => packing.finish(s.shipmentId, STATION, packer), /not in a carton/);
  const c2 = await packing.openCarton(s.shipmentId, packer);
  await packing.scanUnit(c2.cartonId, u2.unit.unitCode, packer);
  await packing.closeCarton(c2.cartonId, { mg: 150_000, weightSource: 'typed' }, STATION, packer);
  await assert.rejects(async () => packing.finish(s.shipmentId, STATION, packer), /label/);
  await printAll(u1.unit.unitCode);
  await printAll(u2.unit.unitCode);
  const done = await packing.finish(s.shipmentId, STATION, packer);
  assert.equal(done.shipment.status, 'PACKED');
  assert.equal(done.shipment.cartonCount, 2);
  assert.equal(done.cartonLabels.length, 2);
  assert.match(done.cartonLabels[1]!.template.elements.map((e) => e.s).join(' '), /Carton: 2 of 2/);
  assert.match(done.packingList.template.elements.map((e) => e.s).join(' '), /PACKING LIST/);
  await assert.rejects(async () => packing.addUnit(s.shipmentId, unitBody(fg), STATION, packer), /PACKED/);
});

test('WALK2-RP-9: candidates list open orders and QC-passed lots by number; a shipment names its lots', async () => {
  const so = await order();
  const ok = await fgLot(), failed = await fgLot({ qc: 'FAIL' }), none = await fgLot({ qc: null });
  const c = await packing.candidates();
  assert.ok(c.orders.some((o) => o.salesOrderId === so && /^SO-/.test(String(o.soNumber))));
  const ids = c.lots.map((l) => l.finishedGoodBatchId);
  assert.ok(ids.includes(ok));
  assert.ok(!ids.includes(failed) && !ids.includes(none), 'only a lot whose latest packaging QC passed');
  assert.match(String(c.lots.find((l) => l.finishedGoodBatchId === ok)!.batchNumber), /^FG-/);
  const s = await packing.start({ salesOrderId: so, finishedGoodBatchIds: [ok] }, packer);
  const full = await packing.shipment(s.shipmentId);
  assert.deepEqual(full.lotNames.map((l) => l.finishedGoodBatchId), [ok]);
  assert.match(String(full.lotNames[0]!.batchNumber), /^FG-/);
});
