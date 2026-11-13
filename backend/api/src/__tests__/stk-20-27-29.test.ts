/**
 * STOCK-FIX-RP, item 7: STK-20 (the FG label's net quantity is ONE pack's net content, not the lot's
 * count in pcs), STK-27 (a verifier's typed weight needs a second person's signed check, and a weight
 * never defaults to typed) and STK-29 (GET /v1/inventory-availability pages with a cursor instead of
 * stopping at 200). Real Postgres, the real services.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { FgLabelService, packNetContent, labelNetContent } from '../packaging-qc/fg-label.service.js';
import { InventoryViewService } from '../inventory-view/inventory-view.service.js';
import { ScaleService } from '../floor-ops/scale.service.js';
import { PickingService, MixingService, BatchService } from '@ra/cluster-production';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { FloorStationService } from '../floor/floor-station.service.js';
import { ensureSchema, testClient, productionDb, principal, closeTestClient } from '../../../test-support/db.js';
import { finishedGood, rack } from '../../../test-support/produce-fixtures.js';

const sql = () => testClient();
before(async () => { await ensureSchema(); });
after(closeTestClient);

/* ── STK-20 ───────────────────────────────────────────────────────────────────────────────── */

test('STK-20: a pack\'s net content, as declared: mass from net_content_mg, else the pack size; a volume stays a volume', () => {
  assert.deepEqual(packNetContent(100_000, '100 g bottle'), { value: '100', unit: 'g' });
  assert.deepEqual(packNetContent('25000000', null), { value: '25', unit: 'kg' });
  assert.deepEqual(packNetContent(1_500, null), { value: '1.5', unit: 'g' });
  assert.deepEqual(packNetContent(500, null), { value: '500', unit: 'mg' });
  assert.deepEqual(packNetContent(null, '50 ml'), { value: '50', unit: 'ml' });
  assert.deepEqual(packNetContent(null, '1 L'), { value: '1', unit: 'L' });
  assert.equal(packNetContent(null, '100 g bottle'), null);
  assert.equal(packNetContent(null, null), null);
});

test('STK-20: the label prints the pack (100 g), the lot total is its own field; a SKU with no net content is never labelled', async () => {
  const labels = new FgLabelService(testClient());
  await rack();
  const fg = await finishedGood({ coa: 'RELEASED' });
  await sql()`update packaging.product_sku set pack_size = '100 g', net_content_mg = 100000 where sku_code = ${fg.skuCode}`;
  const c = await labels.preview(fg.fgBatchId, principal());
  assert.deepEqual([c.netQuantity, c.unit], ['100', 'g']);
  assert.notEqual(c.unit, 'pcs');
  assert.equal(c.lotQuantity, '4');
  const fg2 = await finishedGood({ coa: 'RELEASED' });
  await sql()`update packaging.product_sku set pack_size = 'one bottle', net_content_mg = null where sku_code = ${fg2.skuCode}`;
  await assert.rejects(() => labels.preview(fg2.fgBatchId, principal()), (e: unknown) => e instanceof ConflictException && /net quantity/.test((e as Error).message));
});

/* ── STK-27 ───────────────────────────────────────────────────────────────────────────────── */

const vault: VaultPort = { async resolveManufacturingInstruction() { return null; }, async resolvePickList() { return null; } };

async function jobAtVerify() {
  const codes = new FloorCodeService(sql());
  const db = productionDb();
  const stations = new FloorStationService(sql(), codes, new PickingService(db, vault), new MixingService(db), new BatchService(db));
  const admin = principal({ roles: ['admin'], userId: randomUUID() });
  const t = randomUUID().slice(0, 6).toUpperCase();
  const fam = `fam_${t.toLowerCase()}`;
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  await codes.setFamily({ familyCode: fam, familyName: `F ${t}`, colourName: `Tone${letters}`, colourHex: '#E8C547' }, admin);
  await sql()`insert into platform.uom_master (uom_code, uom_name, status) values ('g', 'g', 'ACTIVE') on conflict (uom_code) do nothing`;
  const [g] = await sql()`select uom_id::text from platform.uom_master where uom_code = 'g'`;
  const m = randomUUID();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status) values (${m}, ${'M-' + t}, ${'Probe ' + t}, 'ACTIVE')`;
  await codes.assignCode(m, fam, principal({ permissions: ['masterdata:material:reveal'] }));
  const rb = randomUUID(), ib = randomUUID(), bin = randomUUID(), binCode = `PF-T-${t}`;
  await sql()`insert into location.bin_master (bin_id, bin_code, status) values (${bin}, ${binCode}, 'ACTIVE')`;
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values (${rb}, ${m}, ${'RM-' + t}, '2099-01-01', 'ACTIVE')`;
  await sql()`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values (${randomUUID()}, ${rb}, 'ACCEPT')`;
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values (${ib}, ${rb}, ${m}, ${bin}, 1000, ${g!.uom_id}, 'ACTIVE')`;
  const orderId = randomUUID(), pl = randomUUID();
  await sql()`insert into production.production_order (production_order_id, order_qty, uom_id, status) values (${orderId}, 1, ${g!.uom_id}, 'INPROGRESS')`;
  await sql()`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pl}, ${orderId}, 'ACTIVE')`;
  await sql()`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status) values (${randomUUID()}, ${pl}, ${m}, 12.5, ${g!.uom_id}, 'ACTIVE')`;
  const job = await stations.createJob(orderId, {}, admin);
  const picker = principal({ roles: ['picker'], userId: randomUUID() });
  const [line] = (await stations.pickView(job.floorJobId)).lines;
  await stations.pickLine(job.floorJobId, line!.floorLineId, { bin: binCode, barcode: await codes.lotBarcode(ib, null) }, picker);
  await stations.completePick(job.floorJobId, { tote: `T-${t}` }, picker);
  return { stations, job, lineId: line!.floorLineId };
}

test('STK-27: a weight with no source is refused, never read as typed', async () => {
  const { stations, job, lineId } = await jobAtVerify();
  const verifier = principal({ roles: ['verifier'], userId: randomUUID() });
  await assert.rejects(() => stations.verifyLine(job.floorJobId, lineId, { actualMg: 12_500 }, verifier),
    (e: unknown) => e instanceof BadRequestException && /Say where the weight came from/.test((e as Error).message));
});

test('STK-27: a typed weight is refused alone, unsigned, by another typist or at another figure; signed, it is used once', async () => {
  const { stations, job, lineId } = await jobAtVerify();
  const scales = new ScaleService(testClient());
  const verifier = principal({ roles: ['verifier'], userId: randomUUID() });
  const other = principal({ roles: ['verifier'], userId: randomUUID() });
  const supervisor = principal({ roles: ['supervisor'], userId: randomUUID() });
  await assert.rejects(() => stations.verifyLine(job.floorJobId, lineId, { actualMg: 12_500, source: 'typed' }, verifier), /needs a second person/);
  const c = await scales.requestTypedCheck({ station: 'Floor', mg: 12_500, reason: 'scale off' }, verifier);
  await assert.rejects(() => stations.verifyLine(job.floorJobId, lineId, { actualMg: 12_500, source: 'typed', weightCheckId: c.checkId }, verifier), /not signed yet/);
  await scales.signTypedCheck(c.checkId, supervisor);
  await assert.rejects(() => stations.verifyLine(job.floorJobId, lineId, { actualMg: 12_500, source: 'typed', weightCheckId: c.checkId }, other), /someone else typed/);
  await assert.rejects(() => stations.verifyLine(job.floorJobId, lineId, { actualMg: 12_501, source: 'typed', weightCheckId: c.checkId }, verifier), /does not match/);
  const ok = await stations.verifyLine(job.floorJobId, lineId, { actualMg: 12_500, source: 'typed', weightCheckId: c.checkId }, verifier);
  assert.equal(ok.verified, true);
  const [row] = await sql()`select status, used_for from platform.typed_weight_check where check_id = ${c.checkId}`;
  assert.equal(row!.status, 'USED');
  assert.match(String(row!.used_for), new RegExp(`${job.jobNo} line 1`));
  const [fl] = await sql()`select weigh_source from production.floor_line where floor_line_id = ${lineId}`;
  assert.equal(fl!.weigh_source, 'typed');
});

/* ── STK-29 ───────────────────────────────────────────────────────────────────────────────── */

test('STK-29: availability pages with a cursor in FEFO order, every lot once, none skipped', async () => {
  const svc = new InventoryViewService(testClient());
  const m = randomUUID();
  const expiries = ['2027-01-01', '2027-01-01', '2027-02-01', null, null, '2026-12-15', '2027-03-01'];
  for (const [i, e] of expiries.entries()) {
    const rb = randomUUID();
    await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values (${rb}, ${m}, ${i === 3 ? null : 'P29-' + i}, ${e}, 'ACTIVE')`;
    await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, quantity_on_hand, status) values (${randomUUID()}, ${rb}, ${m}, ${10 + i}, 'ACTIVE')`;
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const p = await svc.availability({ materialId: m, limit: 3, cursor });
    seen.push(...p.items.map((x) => String((x as Record<string, unknown>).inventoryBatchId)));
    cursor = p.nextCursor ?? undefined;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  const all = await svc.availability({ materialId: m, limit: 200 });
  assert.deepEqual(seen, all.items.map((x) => String((x as Record<string, unknown>).inventoryBatchId)), 'the pages are the one list, in order');
  assert.equal(all.nextCursor, null);
  assert.equal(String((all.items[0] as Record<string, unknown>).batchNumber), 'P29-5', 'first to expire first');
  await assert.rejects(() => svc.availability({ cursor: 'not-a-cursor' }), BadRequestException);
});

test('STK-33: a lot left as BULK is labelled with its own mass; it has no pack, and used to be refused a label for ever', () => {
  // The joint rehearsal: a bulk lot (counted in kg, lead ruling LD-145) of a SKU with no pack was refused a label
  // ("no net content on file"), so packaging QC refused it, it was never released, never put away, and
  // fg.batch.received was never sent: a lot left as bulk could not reach the sales system at all.
  assert.deepEqual(labelNetContent({ netContentMg: null, packSize: null, lotQty: 1.9, lotUomCode: 'kg' }), { value: '1.9', unit: 'kg' });
  assert.deepEqual(labelNetContent({ netContentMg: null, packSize: null, lotQty: '2500.0000', lotUomCode: 'G' }), { value: '2500', unit: 'g' });
  // A filled lot is one pack's net content, exactly as before, whatever the count.
  assert.deepEqual(labelNetContent({ netContentMg: 100_000, packSize: '100 g', lotQty: 49, lotUomCode: 'pcs' }), { value: '100', unit: 'g' });
  // A lot counted in packs with no pack on file is still refused: nothing is guessed.
  assert.equal(labelNetContent({ netContentMg: null, packSize: null, lotQty: 4, lotUomCode: 'pcs' }), null);
  assert.equal(labelNetContent({ netContentMg: null, packSize: null, lotQty: 0, lotUomCode: 'kg' }), null);
});
