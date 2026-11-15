/**
 * RP-BE-1 — the RAC OS Factory console's reads and writes (factory-desk.*), against a real Postgres
 * (backend/test-support/db.ts). Each test builds its own rows under fresh ids, so it does not depend
 * on what other files left behind, and asserts by those ids rather than by table counts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ensureSchema, testClient, principal } from '../../../test-support/db.js';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { FactoryDeskService } from '../factory-desk/factory-desk.service.js';
import { FactoryDeskWritesService } from '../factory-desk/factory-desk-writes.service.js';
import { FactoryDeskController } from '../factory-desk/factory-desk.controller.js';
import { ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

before(ensureSchema);
after(() => testClient().end());

const sql = () => testClient();
const reads = () => new FactoryDeskService(sql());
const writes = () => new FactoryDeskWritesService(sql(), reads());
const me = principal({ userId: '00000000-0000-7000-8000-00000000be01' });

/** A family colour unique to this run, so codes never collide with another file's rows. */
async function family() {
  const letters = randomUUID().replace(/[^a-f]/g, '').slice(0, 6).toUpperCase().padEnd(6, 'Q');
  const colour = `Tst${letters.toLowerCase()}`;
  const fam = `t_${letters.toLowerCase()}`;
  await sql()`insert into masterdata.floor_family_colour (family_code, family_name, colour_name, colour_hex, initial, updated_by)
              values (${fam}, 'Test family', ${colour}, ${'#' + randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}, 'T', 'test')`;
  return { fam, colour, prefix: colour.toUpperCase() };
}

async function uom(code: string) {
  const [r] = await sql()`select uom_id::text as id from platform.uom_master where uom_code = ${code} limit 1`;
  if (r) return String(r.id);
  const id = randomUUID();
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${id}, ${code}, ${code}, 'ACTIVE')`;
  return id;
}

/** A material with a floor code, a lot of `qtyKg` in a bin, and a reorder level of `reorderKg`. */
async function codedMaterial(f: { fam: string; colour: string; prefix: string }, n: number, qtyKg: string, reorderKg: string | null) {
  const kg = await uom('KG');
  const materialId = randomUUID();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status, uom_id, reorder_level)
              values (${materialId}, ${'MAT-' + materialId.slice(0, 8)}, 'SECRET MATERIAL NAME', 'ACTIVE', ${kg}, ${reorderKg})`;
  await sql()`insert into masterdata.floor_code (material_id, family_code, number, created_by) values (${materialId}, ${f.fam}, ${n}, 'test')`;
  const rmBatchId = randomUUID();
  const lot = `RMT-${rmBatchId.slice(0, 8)}`;
  await sql()`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, received_qty, uom_id, status, expiry_date)
              values (${rmBatchId}, ${materialId}, ${lot}, ${qtyKg}, ${kg}, 'RELEASED', '2027-06-30')`;
  const binId = randomUUID();
  const bin = `BIN-${binId.slice(0, 6)}`;
  await sql()`insert into location.storage_location_master (storage_location_id, storage_location_code) values (${binId}, ${bin})`;
  const inventoryBatchId = randomUUID();
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status)
              values (${inventoryBatchId}, ${rmBatchId}, ${materialId}, ${binId}, ${qtyKg}, ${kg}, 'AVAILABLE')`;
  return { materialId, code: `${f.prefix}-${String(n).padStart(4, '0')}`, lot, bin, rmBatchId, inventoryBatchId };
}

/** A floor job mixed into an oil batch, with one picked line and one booked QC round proposing `proposal`. */
async function mixedBatch(line: { materialId: string; inventoryBatchId: string }, proposal: string | null) {
  const oilBatchId = randomUUID();
  const batchNo = `OBT-${oilBatchId.slice(0, 8)}`;
  await sql()`insert into production.oil_batch_master (oil_batch_id, batch_number, status, produced_qty) values (${oilBatchId}, ${batchNo}, 'IN_PROGRESS', '5')`;
  const jobId = randomUUID();
  const jobNo = `J-${jobId.slice(0, 6)}`;
  await sql()`insert into production.floor_job (floor_job_id, production_order_id, material_pick_list_id, job_no, stage, batch_no, oil_batch_id, picked_by, picked_dt, verified_by, verified_dt, mixed_by, mixed_dt, created_by)
              values (${jobId}, ${randomUUID()}, ${randomUUID()}, ${jobNo}, 'MIX', ${batchNo}, ${oilBatchId}, 'picker-1', now() - interval '3 hours', 'verifier-1', now() - interval '2 hours', 'mixer-1', now() - interval '1 hour', 'test')`;
  await sql()`insert into production.floor_line (floor_line_id, floor_job_id, material_pick_list_item_id, material_id, seq, target_mg, tolerance_ppm, picked_batch_id, picked_mg, actual_mg)
              values (${randomUUID()}, ${jobId}, ${randomUUID()}, ${line.materialId}, 1, 250000, 5000, ${line.inventoryBatchId}, 250100, 250050)`;
  if (proposal) {
    await sql()`insert into quality.batch_qc_round (batch_qc_round_id, oil_batch_id, round_no, qc_checkpoint_set_id, inspector_id, results, decision, reasons, policy_version)
                values (${randomUUID()}, ${oilBatchId}, 1, ${randomUUID()}, 'qc-1', '[]'::jsonb, ${proposal}, '[]'::jsonb, 1)`;
  }
  return { oilBatchId, batchNo, jobId, jobNo };
}

/* ── reads ─────────────────────────────────────────────────────────────────────────────────── */

test('stock cover: on hand and reorder in mg by floor code, below reorder flagged, cover not invented', async () => {
  const f = await family();
  const low = await codedMaterial(f, 11, '1.5', '2');
  const ok = await codedMaterial(f, 12, '9', '2');
  const all = await reads().stockCover({ q: f.prefix, limit: '100' });
  const a = all.items.find((r) => r.code === low.code)!;
  const b = all.items.find((r) => r.code === ok.code)!;
  assert.equal(a.onHandMg, 1_500_000);
  assert.equal(a.reorderAtMg, 2_000_000);
  assert.equal(a.belowReorder, true);
  assert.equal(b.belowReorder, false);
  assert.deepEqual(a.bins, [low.bin]);
  assert.equal(a.coverDays, null, 'cover in days is not held, so it is null, never 0');
  assert.match(all.coverNote, /does not hold/);
  const lowOnly = await reads().stockCover({ q: f.prefix, state: 'low' });
  assert.deepEqual(lowOnly.items.map((r) => r.code), [low.code]);
  assert.ok(!JSON.stringify(all).includes('SECRET MATERIAL NAME'), 'no material name in a coded read');
});

test('floor codes list, one code summary and its lots FEFO, all coded', async () => {
  const f = await family();
  const m = await codedMaterial(f, 417, '3', null);
  const list = await reads().floorCodes();
  assert.ok(list.items.some((r) => r.code === m.code && r.familyCode === f.fam));
  const one = await reads().codeSummary(m.code);
  assert.equal(one.code, m.code);
  assert.equal(one.onHandMg, 3_000_000);
  assert.equal(one.reorderAtMg, null, 'no reorder level on file: null, and belowReorder unknown');
  assert.equal(one.belowReorder, null);
  assert.equal(one.lots, 1);
  const lots = await reads().codeLots(m.code);
  assert.equal(lots.items.length, 1);
  assert.equal(lots.items[0]!.lot, m.lot);
  assert.equal(lots.items[0]!.bin, m.bin);
  assert.equal(lots.items[0]!.held, false);
  assert.ok(!JSON.stringify([list, one, lots]).includes('SECRET MATERIAL NAME'));
  await assert.rejects(reads().codeSummary('not a code'), /colour and a number/);
  await assert.rejects(reads().codeLots(`${f.prefix}-9999`), /No floor code/);
});

test('board, one batch and its route: stage from what the batch has, lines coded with grams, QC proposal and call apart', async () => {
  const f = await family();
  const m = await codedMaterial(f, 21, '5', null);
  const b = await mixedBatch(m, 'APPROVE');
  const board = await reads().board();
  const row = board.items.find((r) => r.oilBatchId === b.oilBatchId)!;
  assert.equal(row.stage, 'APPROVED', 'last round proposes APPROVE and no maceration is open');
  const one = await reads().batch(b.batchNo);
  assert.equal(one.batchNo, b.batchNo);
  assert.equal(one.lines.length, 1);
  assert.equal(one.lines[0]!.code, m.code);
  assert.equal((one.lines[0] as Record<string, unknown>).targetMg, '250000');
  assert.equal((one.lines[0] as Record<string, unknown>).pickedLot, m.lot);
  assert.equal((one.lines[0] as Record<string, unknown>).state, 'OPEN');
  assert.equal(one.qcRounds[0]!.proposal, 'APPROVE');
  assert.equal(one.qcRounds[0]!.decision, null, 'no person has made the call yet');
  assert.ok(!JSON.stringify(one).includes('SECRET MATERIAL NAME'));
  const route = await reads().batchRoute(b.jobNo);
  assert.deepEqual(route.steps.map((s) => s.station), ['PICK', 'VERIFY', 'MIX', 'QC ROUND 1']);
  assert.equal(route.steps[0]!.by, 'picker-1');
  assert.equal(route.steps[3]!.state, 'BOOKED');
  await assert.rejects(reads().batch('NO-SUCH-BATCH'), /No batch or job/);
});

/* LD-272: the one-batch read through the ALEMBIC relay carries each coded line's code, state, who and
 * when, and NO quantity: target grams per floor code are the recipe by another name, so a relay token
 * never receives them. A person signed in on RawProd itself still gets the floor's batch sheet. */
const QUANTITY_KEYS = ['targetMg', 'tolerancePpm', 'pickedMg', 'actualMg', 'producedQty'];
function quantityKeysIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => quantityKeysIn(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { if (QUANTITY_KEYS.includes(k)) out.push(k); quantityKeysIn(x, out); }
  }
  return out;
}

test('LD-272: one batch through the relay: each line coded with state, who and when, and no quantity anywhere', async () => {
  const f = await family();
  const m = await codedMaterial(f, 22, '5', null);
  const b = await mixedBatch(m, 'APPROVE');
  await sql()`update production.floor_line set picked_by = 'picker-7', picked_dt = now() - interval '90 minutes' where floor_job_id = ${b.jobId}`;
  const ctl = new FactoryDeskController(reads(), writes());
  const relayed = await ctl.batch(b.batchNo, principal({ userId: me.userId, via: 'relay' }));
  assert.deepEqual(quantityKeysIn(relayed), [], 'no target, tolerance, picked, actual or produced quantity reaches a relay token');
  const line = relayed.lines[0] as Record<string, unknown>;
  assert.equal(line.code, m.code);
  assert.equal(line.state, 'PICKED');
  assert.equal(line.by, 'picker-7');
  assert.match(String(line.at), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(relayed.batchNo, b.batchNo, 'the rest of the batch (stage, rounds, hold) is still served');
  assert.equal(relayed.qcRounds[0]!.proposal, 'APPROVE');
  assert.ok(!JSON.stringify(relayed).includes('SECRET MATERIAL NAME'));
});

test('LD-272: one batch for a person signed in on RawProd: the floor\'s batch sheet with its grams, as before', async () => {
  const f = await family();
  const m = await codedMaterial(f, 23, '5', null);
  const b = await mixedBatch(m, null);
  const ctl = new FactoryDeskController(reads(), writes());
  const own = await ctl.batch(b.batchNo, principal({ userId: me.userId }));
  const line = own.lines[0] as Record<string, unknown>;
  assert.equal(line.targetMg, '250000');
  assert.equal(line.tolerancePpm, 5000);
  assert.equal(line.pickedMg, '250100');
  assert.equal(line.actualMg, '250050');
  assert.equal(Number(own.batch!.producedQty), 5);
  assert.equal(line.state, 'OPEN');
  assert.equal(line.by, null, 'nobody has picked it');
});

/* LD-272b: what a batch MAKES (product, grade, planned and produced mass of output) is production
 * volume, not recipe content: it reaches a relay token on the batch and on the board. The per-line
 * quantities stay out exactly as LD-272 says. The product's name follows RawProd's own rule for it
 * (formula:actual:read, as the dashboard and the trace show it); without that it is said, not blanked. */
async function withOutput(b: { jobId: string; oilBatchId: string }, opts: { plannedKg: string; producedKg: string }) {
  const kg = await uom('KG');
  const formulaId = randomUUID();
  const planItemId = randomUUID();
  const productId = randomUUID();
  const productCode = `PRT-${productId.slice(0, 6)}`;
  await sql()`insert into production.production_plan_items (production_plan_item_id, formula_id, planned_qty, uom_id, status) values (${planItemId}, ${formulaId}, ${opts.plannedKg}, ${kg}, 'PLANNED')`;
  const [j] = await sql()`select production_order_id::text as id from production.floor_job where floor_job_id = ${b.jobId}::uuid`;
  await sql()`insert into production.production_order (production_order_id, production_plan_item_id, order_qty, uom_id, status) values (${String(j!.id)}::uuid, ${planItemId}, ${opts.plannedKg}, ${kg}, 'RELEASED')`;
  await sql()`update production.oil_batch_master set produced_qty = ${opts.producedKg}, uom_id = ${kg} where oil_batch_id = ${b.oilBatchId}::uuid`;
  await sql()`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status) values (${productId}, ${formulaId}, ${productCode}, 'Test Output Oil', 'ACTIVE')`;
  await sql()`insert into bridge.catalogue_item (alembic_sku_id, sku_code, name, classification, classification_basis, grade, product_id, synced_by)
              values (${randomUUID()}, ${'SKU-' + productId.slice(0, 6)}, 'Test Output Oil', 'blend', 'test', 'Test Grade A', ${productId}, 'test')`;
  return { productCode };
}

test('LD-272b: a batch\'s OUTPUT reaches a relay token on the batch and the board; no per-line quantity does', async () => {
  const f = await family();
  const m = await codedMaterial(f, 25, '5', null);
  const b = await mixedBatch(m, 'APPROVE');
  const { productCode } = await withOutput(b, { plannedKg: '12.5', producedKg: '12.25' });
  const ctl = new FactoryDeskController(reads(), writes());
  const relayToken = principal({ userId: me.userId, via: 'relay', permissions: ['production:floor_queue:read', 'formula:actual:read'] });
  const relayed = await ctl.batch(b.batchNo, relayToken);
  assert.deepEqual(quantityKeysIn(relayed), [], 'per-line target, tolerance, picked, actual (and the raw produced_qty) stay out');
  assert.deepEqual(relayed.output, {
    productCode, productName: 'Test Output Oil', grade: 'Test Grade A', plannedMg: 12_500_000, producedMg: 12_250_000, unconverted: false, productNote: null,
  });
  const row = (await ctl.board(relayToken)).items.find((r) => r.oilBatchId === b.oilBatchId)!;
  assert.deepEqual(row.output, relayed.output, 'the board row carries the same output');
  // RawProd's own rule for a product's name: without formula:actual:read it is not shown, and the answer says so.
  const plain = principal({ userId: me.userId, via: 'relay', permissions: ['production:floor_queue:read'] });
  const hidden = (await ctl.batch(b.batchNo, plain)).output as Record<string, unknown>;
  assert.equal(hidden.productName, null);
  assert.equal(hidden.productCode, null);
  assert.equal(hidden.plannedMg, 12_500_000, 'volume is not the product\'s name: it is still served');
  assert.match(String(hidden.productNote), /not shown/i);
});

test('LD-272b: output the factory does not hold is null with the reason, never 0 and never guessed', async () => {
  const f = await family();
  const m = await codedMaterial(f, 26, '5', null);
  const b = await mixedBatch(m, null);
  await sql()`update production.oil_batch_master set produced_qty = null where oil_batch_id = ${b.oilBatchId}::uuid`;
  const ctl = new FactoryDeskController(reads(), writes());
  const out = (await ctl.batch(b.batchNo, principal({ userId: me.userId, via: 'relay', permissions: ['formula:actual:read'] }))).output as Record<string, unknown>;
  assert.equal(out.plannedMg, null, 'no production order on file: planned is not known');
  assert.equal(out.producedMg, null, 'not produced yet: null, not 0');
  assert.equal(out.productName, null);
  assert.equal(out.grade, null);
  assert.match(String(out.productNote), /not recorded/i);
});

test('QC queue: a batch with no approving round and a quarantined raw lot, one list, oldest first', async () => {
  const f = await family();
  const m = await codedMaterial(f, 31, '5', null);
  const b = await mixedBatch(m, 'HOLD_RETEST');
  await sql()`update inventory.rm_batch_master set status = 'QUARANTINE' where rm_batch_id = ${m.rmBatchId}`;
  const q = await reads().qcQueue({ limit: '100' });
  const all = [...q.items];
  for (let c = q.nextCursor; c; ) { const n = await reads().qcQueue({ cursor: c, limit: '100' }); all.push(...n.items); c = n.nextCursor; }
  assert.ok(all.some((r) => r.kind === 'BATCH' && r.id === b.oilBatchId && r.lastProposal === 'HOLD_RETEST'));
  const lot = all.find((r) => r.kind === 'RM_LOT' && r.id === m.rmBatchId)!;
  assert.equal(lot.code, m.code);
  const onlyRm = await reads().qcQueue({ kind: 'rm', limit: '100' });
  assert.ok(onlyRm.items.every((r) => r.kind === 'RM_LOT'));
});

test('today: counts from the data, and what is not held is null', async () => {
  const t = await reads().today();
  assert.equal(typeof t.tiles.onTheFloor, 'number');
  assert.equal(typeof t.tiles.qcWaiting.rmLots, 'number');
  assert.equal(t.planned, null);
  assert.equal(t.history, null);
  assert.deepEqual(t.stationsToday.map((s) => s.station), ['PICK', 'VERIFY', 'MIX']);
});

test('trace list: a batch with how many raw lots went into it', async () => {
  const f = await family();
  const m = await codedMaterial(f, 41, '5', null);
  const b = await mixedBatch(m, null);
  const t = await reads().traceBatches({ q: b.batchNo });
  assert.equal(t.total, 1);
  assert.equal(t.items[0]!.rawLots, 1);
});

/* ── writes ────────────────────────────────────────────────────────────────────────────────── */

test('QC call: CONFIRM takes the proposal; a call against it needs a reason; a round takes one call; nothing is released', async () => {
  const f = await family();
  const m = await codedMaterial(f, 51, '5', null);
  const b = await mixedBatch(m, 'APPROVE');
  await assert.rejects(writes().decideQc(b.oilBatchId, '1', { decision: 'REJECT' }, me), /needs a reason/);
  const c = await writes().decideQc(b.oilBatchId, '1', { decision: 'REJECT', reason: 'odour off against the reference' }, me);
  assert.equal(c.proposal, 'APPROVE');
  assert.equal(c.decision, 'REJECT');
  assert.equal(c.overridesProposal, true);
  assert.equal(c.decidedBy, me.userId);
  await assert.rejects(writes().decideQc(b.oilBatchId, '1', { decision: 'CONFIRM' }, me), /already has its call/);
  const [batch] = await sql()`select status from production.oil_batch_master where oil_batch_id = ${b.oilBatchId}`;
  assert.equal(batch!.status, 'IN_PROGRESS', 'the call is recorded; the batch is not released or rejected by it');
  const b2 = await mixedBatch(m, 'APPROVE');
  const c2 = await writes().decideQc(b2.oilBatchId, '1', { decision: 'CONFIRM' }, me);
  assert.equal(c2.decision, 'APPROVE');
  assert.equal(c2.overridesProposal, false);
  const b3 = await mixedBatch(m, 'REVIEW');
  await assert.rejects(writes().decideQc(b3.oilBatchId, '1', { decision: 'CONFIRM' }, me), /no proposal/);
  await assert.rejects(writes().decideQc(b3.oilBatchId, '2', { decision: 'APPROVE', reason: 'x'.repeat(5) }, me), /No QC round 2/);
});

test('recall: number assigned by the system, the lot goes on hold in the same step, one open recall per lot', async () => {
  const f = await family();
  const m = await codedMaterial(f, 61, '5', null);
  await assert.rejects(writes().startRecall({ lot: m.lot }, me), /Say why/);
  const r = await writes().startRecall({ lot: m.lot, reason: 'supplier recall notice' }, me);
  assert.match(r.recallNo as string, /^RCL-\d{5,}$/);
  assert.equal(r.subjectType, 'RM_LOT');
  const [hold] = await sql()`select lot_hold_id::text as id, source from inventory.lot_hold where subject_type = 'RM_LOT' and subject_id = ${m.rmBatchId} and released_dt is null`;
  assert.equal(hold!.id, r.lotHoldId);
  assert.equal(hold!.source, 'RECALL');
  await assert.rejects(writes().startRecall({ lot: m.lot, reason: 'again' }, me), /already open/);
  const list = await reads().recalls({ limit: '100' });
  assert.ok(list.items.some((x) => x.recallNo === r.recallNo));
  const [onHand] = await sql()`select quantity_on_hand::text as q from inventory.inventory_batch where inventory_batch_id = ${m.inventoryBatchId}`;
  assert.equal(Number(onHand!.q), 5, 'a recall holds the lot; it does not edit a stock figure');
});

test('PO sent back: only one awaiting approval, with who, why and when', async () => {
  const id = randomUUID();
  await sql()`insert into procurement.purchase_order (purchase_order_id, po_number, status, created_by) values (${id}, ${'PO-T-' + id.slice(0, 6)}, 'DRAFT', 'creator')`;
  await assert.rejects(writes().rejectPo(id, { reason: '' }, me), /Say why/);
  const r = await writes().rejectPo(id, { reason: 'wrong supplier price' }, me);
  assert.equal(r.status, 'RETURNED');
  assert.equal(r.rejectedBy, me.userId);
  assert.equal(r.rejectedReason, 'wrong supplier price');
  await assert.rejects(writes().rejectPo(id, { reason: 'again please' }, me), /awaiting approval/);
});

test('print job cancel: queued only; a printed label cannot be taken back', async () => {
  const a = randomUUID();
  const b = randomUUID();
  await sql()`insert into platform.print_job (print_job_id, station, label_kind, subject_ref, template, status) values (${a}, 'PICK', 'bin', 'X', '{}'::jsonb, 'queued'), (${b}, 'PICK', 'bin', 'Y', '{}'::jsonb, 'printed')`;
  assert.equal((await writes().cancelPrintJob(a)).status, 'cancelled');
  await assert.rejects(writes().cancelPrintJob(b), /printed/);
});

test('device test: asked from the desk, REQUESTED until the device reports; a revoked device is refused', async () => {
  const d = randomUUID();
  await sql()`insert into platform.device_master (device_id, kind, station, name, status, paired_at) values (${d}, 'kiosk', 'PICK', 'Test kiosk', 'active', now())`;
  const before = await reads().deviceTest(d);
  assert.equal(before.test, null);
  assert.equal(before.paired, true);
  await writes().requestDeviceTest(d, me);
  const after = await reads().deviceTest(d);
  assert.equal(after.test!.state, 'REQUESTED');
  assert.equal(after.test!.result, null, 'no result is assumed');
  await sql()`update platform.device_master set status = 'revoked', revoked_at = now() where device_id = ${d}`;
  await assert.rejects(writes().requestDeviceTest(d, me), /revoked/);
});

test('operating rules and maceration defaults: append-only, newest wins, a reason every time', async () => {
  const site = `T${randomUUID().slice(0, 6).toUpperCase()}`;
  await assert.rejects(writes().saveOperatingRules({ site, values: { 'kiosk.idle_lock_min': 2 } }, me), /Say why/);
  await assert.rejects(writes().saveOperatingRules({ site, values: { 'Bad Key': 2 }, reason: 'because' }, me), /not a rule key/);
  await assert.rejects(writes().saveOperatingRules({ site, values: { 'a.b': { nested: 1 } }, reason: 'because' }, me), /rule value/);
  await writes().saveOperatingRules({ site, values: { 'kiosk.idle_lock_min': 2 }, reason: 'first setting' }, me);
  const r = await writes().saveOperatingRules({ site, values: { 'kiosk.idle_lock_min': 5 }, reason: 'night shift asked' }, me);
  assert.deepEqual(r.items.map((i) => [i.key, i.value, i.versions, i.reason]), [['kiosk.idle_lock_min', 5, 2, 'night shift asked']]);
  await assert.rejects(writes().saveMacerationDefaults(site, { values: [{ productClass: 'EDP', minDays: 9, maxDays: 3 }], reason: 'x'.repeat(4) }, me), /at least the fewest/);
  const m = await writes().saveMacerationDefaults(site, { values: [{ productClass: 'EDP', minDays: 14, maxDays: 28 }], reason: 'house standard' }, me);
  assert.deepEqual(m.items.map((i) => [i.productClass, i.minDays, i.maxDays]), [['EDP', 14, 28]]);
  await assert.rejects(reads().operatingRules(''), /Name the branch/);
});

test('role change request: recorded only, one open per person, the role must exist', async () => {
  const u = randomUUID();
  await sql()`insert into iam.user_master (user_id, user_name, email, is_active, status) values (${u}, 'Test Person', ${u.slice(0, 8) + '@test.invalid'}, true, 'ACTIVE')`;
  const [role] = await sql()`select role_code from iam.role_master limit 1`;
  const roleCode = role ? String(role.role_code) : 'picker';
  if (!role) await sql()`insert into iam.role_master (role_id, role_code, role_name, status) values (${randomUUID()}, 'picker', 'Picker', 'ACTIVE')`;
  await assert.rejects(writes().requestRoleChange({ person: u, toRole: 'no_such_role', reason: 'needed' }, me), /no role/);
  const r = await writes().requestRoleChange({ person: u, toRole: roleCode, reason: 'moves to the mixing station' }, me);
  assert.equal(r.state, 'REQUESTED');
  await assert.rejects(writes().requestRoleChange({ person: u, toRole: roleCode, reason: 'again please' }, me), /already waiting/);
  const people = await reads().factoryPeople({ q: 'Test Person', limit: '100' });
  const p = people.items.find((x) => x.userId === u)!;
  assert.equal((p.pendingChange as { toRole: string }).toRole, roleCode);
  const roles = await sql()`select count(*)::int as n from iam.user_role_mapping where user_id = ${u}`;
  assert.equal(roles[0]!.n, 0, 'asking grants nothing');
});

test('kiosk problem: raises a supervisor alert in the same step; OTHER needs a note', async () => {
  const station = `T-${randomUUID().slice(0, 6)}`;
  await assert.rejects(writes().raiseProblem({ station, kind: 'OTHER' }, me), /Say what is wrong/);
  await assert.rejects(writes().raiseProblem({ station, kind: 'NOPE' }, me), /one of/);
  const r = await writes().raiseProblem({ station, kind: 'SCALE_NOT_READING' }, me);
  assert.equal(r.alertRaised, true);
  const [a] = await sql()`select title, station from platform.floor_alert where floor_alert_id = ${(r as Record<string, unknown>).floorAlertId as string}`;
  assert.equal(a!.station, station);
  assert.match(String(a!.title), /Scale not reading/);
});

test('reveal behind a floor code: reason recorded before the name is returned', async () => {
  const f = await family();
  const m = await codedMaterial(f, 71, '1', null);
  await assert.rejects(writes().revealCode(m.code, {}, me), /Say why/);
  const r = await writes().revealCode(m.code, { reason: 'supplier asked which material' }, me);
  assert.equal((r as Record<string, unknown>).materialName, 'SECRET MATERIAL NAME');
  const [row] = await sql()`select reason, revealed_by from masterdata.floor_code_reveal where code = ${m.code}`;
  assert.equal(row!.reason, 'supplier asked which material');
  assert.equal(row!.revealed_by, me.userId);
});

/* ── authorisation: RawProd's own roles, through the real guard ────────────────────────────── */

const guard = new PermissionsGuard(new Reflector());
const grant = (code: string) => RA_PERMISSIONS.filter((p) => ROLES.find((r) => r.code === code)!.select(p));
function allowed(method: string, role: string): boolean {
  const ctx = {
    getHandler: () => (FactoryDeskController.prototype as unknown as Record<string, unknown>)[method],
    getClass: () => FactoryDeskController,
    switchToHttp: () => ({ getRequest: () => ({ user: principal({ roles: [role], permissions: grant(role) }) }) }),
  };
  try { return guard.canActivate(ctx as never) === true; } catch { return false; }
}

test('authz: each route admits the factory roles that hold its permission and refuses the rest', () => {
  assert.equal(allowed('board', 'production'), true);
  assert.equal(allowed('board', 'sales'), false);
  assert.equal(allowed('decideQc', 'qc'), true);
  assert.equal(allowed('decideQc', 'picker'), false);
  assert.equal(allowed('rejectPo', 'procurement'), true);
  assert.equal(allowed('rejectPo', 'picker'), false);
  assert.equal(allowed('revealCode', 'picker'), false, 'a floor role never sees the name behind a code');
  assert.equal(allowed('saveOperatingRules', 'picker'), false);
});

test('step-up: the routes that go against the next step or open a name are @FreshAuth; plain reads are not', () => {
  const fresh = (m: string) => Reflect.getMetadata('core:freshAuth', (FactoryDeskController.prototype as unknown as Record<string, object>)[m]!) != null;
  const keys = Reflect.getMetadataKeys((FactoryDeskController.prototype as unknown as Record<string, object>).decideQc!);
  const key = keys.find((k) => String(k).toLowerCase().includes('fresh'));
  assert.ok(key, `a fresh-auth metadata key is set (found ${keys.map(String).join(', ')})`);
  const has = (m: string) => Reflect.getMetadata(key, (FactoryDeskController.prototype as unknown as Record<string, object>)[m]!) != null;
  for (const m of ['decideQc', 'startRecall', 'saveOperatingRules', 'requestRoleChange', 'revealCode']) assert.ok(has(m), `${m} needs a fresh step-up`);
  for (const m of ['board', 'batch', 'stockCover', 'cancelPrintJob', 'raiseProblem']) assert.ok(!has(m), `${m} does not`);
  void fresh;
});
