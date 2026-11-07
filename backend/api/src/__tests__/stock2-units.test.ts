/**
 * STOCK2-3: one exact sum across units, and every screen and check that adds or compares stock using it.
 * Mass converts, volume converts, mass and volume do not: those are shown as not totalled, never summed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { netQty } from '@core/data-kernel';
import { ensureSchema, testClient, closeTestClient, inventoryDb, principal } from '../../../test-support/db.js';
import { PlanningService } from '../planning/planning.service.js';
import { InventoryViewService } from '../inventory-view/inventory-view.service.js';
import { stockPosition, availableIn } from '../inventory-view/stock-position.js';
import { MaterialShortageService } from '../automation/material-shortage.service.js';
import { CoverService } from '../planning/cover.service.js';
import { FactsService } from '../facts/facts.service.js';
import { StockService } from '../../../cluster-inventory/src/stock/stock.service.js';

const sql = () => testClient();
const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 6).toUpperCase();
before(async () => {
  await ensureSchema();
  await sql()`create table if not exists inventory.inventory_status_master (inventory_status_id uuid primary key, status_code text)`;
});
after(closeTestClient);

async function uom(code: string) {
  await sql()`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values (${uid()}, ${code}, ${code}, 'ACTIVE') on conflict do nothing`;
  return (await sql()`select uom_id::text from platform.uom_master where uom_code = ${code}`)[0]!.uom_id as string;
}
async function material(unit: string | null, reorder = 0) {
  const id = uid();
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status, uom_id, reorder_level) values (${id}, ${'Z-' + tag()}, 'Stock test', 'ACTIVE', ${unit ? await uom(unit) : null}, ${reorder})`;
  return id;
}
async function lot(m: string, qty: string, unit: string | null) {
  const ib = uid();
  await sql()`insert into inventory.inventory_batch (inventory_batch_id, material_id, quantity_on_hand, uom_id, status) values (${ib}, ${m}, ${qty}, ${unit ? await uom(unit) : null}, 'ACTIVE')`;
  return ib;
}
async function reserve(ib: string, qty: string, unit: string | null) {
  await sql()`insert into inventory.stock_reservation (stock_reservation_id, inventory_batch_id, reserved_qty, uom_id, reserved_dt, status) values (${uid()}, ${ib}, ${qty}, ${unit ? await uom(unit) : null}, now(), 'ACTIVE')`;
}

test('netQty: exact across mass units, and past four places when the sum needs it', () => {
  assert.deepEqual(netQty([{ qty: '1', uom: 'kg' }, { qty: '250', uom: 'g' }], [{ qty: '0.5', uom: 'g' }], 'g'), { qty: '1249.5', uom: 'g' });
  assert.deepEqual(netQty([{ qty: '0.1234', uom: 'g' }], [], 'kg'), { qty: '0.0001234', uom: 'kg' });
  assert.deepEqual(netQty([{ qty: '1', uom: 'l' }, { qty: '250', uom: 'ml' }], [], 'l'), { qty: '1.25', uom: 'l' });
  assert.deepEqual(netQty([{ qty: '0.1', uom: 'g' }, { qty: '0.2', uom: 'g' }], [], 'g'), { qty: '0.3', uom: 'g' }, 'not 0.30000000000000004');
  assert.deepEqual(netQty([{ qty: '1', uom: 'g' }], [{ qty: '3', uom: 'g' }], 'g'), { qty: '-2', uom: 'g' });
  assert.deepEqual(netQty([{ qty: '12', uom: 'pcs' }, { qty: '3', uom: 'PCS' }], [], 'pcs'), { qty: '15', uom: 'pcs' });
});

test('netQty: mass and volume, or a missing unit, are not totalled, and it says so', () => {
  const mixed = netQty([{ qty: '1', uom: 'kg' }, { qty: '1', uom: 'L' }], [], 'kg');
  assert.ok('refused' in mixed);
  assert.deepEqual(mixed.units, ['kg', 'L']);
  assert.match(mixed.refused, /density/);
  assert.ok('refused' in netQty([{ qty: '1', uom: 'kg' }, { qty: '1', uom: null }], [], 'kg'));
  assert.ok('refused' in netQty([{ qty: '1', uom: 'pcs' }], [], 'kg'));
  assert.deepEqual(netQty([{ qty: '0', uom: 'L' }, { qty: '2', uom: 'kg' }], [], 'kg'), { qty: '2', uom: 'kg' }, 'an empty lot does not poison the total');
  assert.deepEqual(netQty([], [], 'kg'), { qty: '0', uom: 'kg' });
});

test('stock position: a kg lot, a g lot and a g reservation net exactly in the unit asked', async () => {
  const m = await material('g');
  const a = await lot(m, '1.0000', 'kg');
  await lot(m, '250.0000', 'g');
  await reserve(a, '100.0000', 'g');
  await reserve(a, '0.0500', null); // no unit on a reservation: it is in the unit of the lot it holds
  const p = (await stockPosition(sql() as never, [m])).get(m)!;
  assert.deepEqual(availableIn(p, 'g'), { qty: '1100', uom: 'g' });
});

test('planning: reorder figures convert; 1 kg + 250 g is 1250 g, not 251', async () => {
  const m = await material('g', 2000);
  await lot(m, '1.0000', 'kg');
  await lot(m, '250.0000', 'g');
  const r = (await new PlanningService(sql() as never).reorderSuggestions(500)).items.find((x) => x.materialId === m)!;
  assert.deepEqual([r.onHand, r.available, r.shortage, r.uom, r.unitNote], [1250, 1250, 750, 'g', null]);
});

test('planning: a material held in kg and litres shows no total and names why', async () => {
  const m = await material('kg', 5);
  await lot(m, '1.0000', 'kg');
  await lot(m, '1.0000', 'L');
  const r = (await new PlanningService(sql() as never).reorderSuggestions(500)).items.find((x) => x.materialId === m)!;
  assert.deepEqual([r.onHand, r.available, r.shortage], [null, null, null]);
  assert.match(String(r.unitNote), /kg and L/);
});

test('stock view: a reservation in g comes off a kg lot in kg', async () => {
  const m = await material('kg');
  const ib = await lot(m, '1.0000', 'kg');
  await reserve(ib, '250.0000', 'g');
  const r = (await new InventoryViewService(sql() as never).availability({ materialId: m })).items[0]!;
  assert.deepEqual([r.onHand, r.reserved, r.available, r.uom], [1, 0.25, 0.75, 'kg']);
});

test('stock view: a reservation that cannot convert leaves free stock blank, with the reason', async () => {
  const m = await material('kg');
  const ib = await lot(m, '1.0000', 'kg');
  await reserve(ib, '1.0000', 'L');
  const r = (await new InventoryViewService(sql() as never).availability({ materialId: m })).items[0]!;
  assert.equal(r.available, null);
  assert.match(String(r.unitNote), /kg and L/);
});

test('reservation check: converts the request and what is held, and refuses what cannot convert', async () => {
  const svc = new StockService(inventoryDb());
  const p = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-00000000f101' });
  const m = await material('kg');
  const ib = await lot(m, '1.0000', 'kg');
  await reserve(ib, '600.0000', 'g');
  const make = (reservedQty: number, unit: string) => uom(unit).then((uomId) => svc.createStockReservation({ inventoryBatchId: ib, reservedQty, uomId } as never, p));
  await assert.rejects(() => make(500, 'g'), /Cannot reserve/, 'only 400 g is free, and 500 is not under 0.4 on a raw compare');
  await assert.rejects(() => make(1, 'L'), /density/);
  await make(400, 'g');
});

test('shortage: lots in kg against a line in g, converted; no purchase request for stock that is there', async () => {
  const m = await material('g');
  await lot(m, '2.0000', 'kg');
  const svc = new MaterialShortageService(sql() as never);
  const orderId = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, status) values (${orderId}, 1, 'INPROGRESS')`;
  await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values (${uid()}, ${orderId}, ${m}, 500, false, ${await uom('g')}, 'ACTIVE')`;
  const out = await (svc as unknown as { evaluate(t: unknown, id: string): Promise<{ decision: string }> }).evaluate(sql(), orderId);
  assert.equal(out.decision, 'NOOP');
});

test('shortage: a line that cannot be compared raises no figure and says which', async () => {
  const m = await material('kg');
  await lot(m, '2.0000', 'L');
  const svc = new MaterialShortageService(sql() as never);
  const orderId = uid();
  await sql()`insert into production.production_order (production_order_id, order_qty, status) values (${orderId}, 1, 'INPROGRESS')`;
  await sql()`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values (${uid()}, ${orderId}, ${m}, 5, false, ${await uom('kg')}, 'ACTIVE')`;
  const out = await (svc as unknown as { evaluate(t: unknown, id: string): Promise<{ decision: string; reason: string }> }).evaluate(sql(), orderId);
  assert.equal(out.decision, 'NOOP');
  assert.match(out.reason, /could not be compared/);
  assert.equal((await sql()`select 1 from procurement.stock_requirement where material_id = ${m}`).length, 0);
});

const rawShort = (bom: unknown[], units: number) => (new CoverService(sql() as never, {} as never) as unknown as { rawShort(q: unknown, b: unknown[], u: number): Promise<Array<{ shortQty: number | null; availableQty: number | null; unitNote?: string }>> }).rawShort(sql(), bom, units);

test('cover: 2 kg on the shelf covers a 500 g need, and a real gap is in the BOM\'s unit', async () => {
  const m = await material('g');
  await lot(m, '2.0000', 'kg');
  const line = { materialId: m, perUnit: 100, uomId: await uom('g'), uomCode: 'g' };
  assert.deepEqual(await rawShort([line], 5), []);
  const [short] = await rawShort([line], 25);
  assert.deepEqual([short!.availableQty, short!.shortQty], [2000, 500]);
});

test('cover: a material that cannot be compared is listed with no figure', async () => {
  const m = await material('kg');
  await lot(m, '2.0000', 'L');
  const [short] = await rawShort([{ materialId: m, perUnit: 1, uomId: await uom('kg'), uomCode: 'kg' }], 1);
  assert.equal(short!.shortQty, null);
  assert.match(String(short!.unitNote), /kg and L/);
});

const availability = (name: string) => (new FactsService(sql() as never, {} as never) as unknown as { materialAvailability(q: string): Promise<Array<Record<string, unknown>>> }).materialAvailability(name);

test('facts: availability converts, and stock that does not convert gives no figure', async () => {
  const t = tag(), code = `F${t}`, code2 = `G${t}`;
  const a = uid(), b = uid(), g = await uom('g'), kg = await uom('kg');
  await sql()`insert into masterdata.material (material_id, material_code, material_name, status, uom_id) values (${a}, ${code}, 'Facts one', 'ACTIVE', ${g}), (${b}, ${code2}, 'Facts two', 'ACTIVE', ${kg})`;
  await lot(a, '1.0000', 'kg');
  await lot(a, '250.0000', 'g');
  await lot(b, '1.0000', 'kg');
  await lot(b, '1.0000', 'L');
  const [one] = await availability(code), [two] = await availability(code2);
  assert.deepEqual([one!.onHandQty, one!.availableQty, one!.uom], [1250, 1250, 'g']);
  assert.deepEqual([two!.onHandQty, two!.availableQty], [null, null]);
  assert.match(String(two!.unitNote), /kg and L/);
});
