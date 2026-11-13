/**
 * STOCK-FIX-RP: STK-7 (the pick list totals the order, in whatever unit), STK-8 (an impossible batch is
 * refused at order creation, saying what to change) and STK-9 (planning reserves the raw lots, a
 * shortfall is known at planning, two orders cannot both be promised the same last kilogram, a cancel
 * releases and the issue converts). Real Postgres, the real PlanningService, PickingService and
 * ConsumptionService. The Vault port is a stub that splits the batch with the Vault's own function
 * (`pickLinesMg`, cluster-formula): the shares below are made up, never the owner's.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { pickLineRequiredQty, pickLinesMg, type PickLine, type VaultPort } from '@ra/cluster-formula';
import { PlanningService } from '../../../cluster-production/src/planning/planning.service.js';
import { PickingService } from '../../../cluster-production/src/picking/picking.service.js';
import { ConsumptionService } from '../consumption/consumption.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

/** A made-up recipe per formula version id: material + percentage (6 places, total 100). */
const recipes = new Map<string, Array<{ materialId: string; percentage: number }>>();
const vault: VaultPort = {
  async resolveManufacturingInstruction() { return null; },
  async resolvePickList(formulaVersionId, orderQty, _ctx, orderMg) {
    const r = recipes.get(formulaVersionId);
    if (!r) return null;
    const mg = orderMg !== undefined ? pickLinesMg(orderMg, r.map((x) => x.percentage)) : null;
    return r.map((x, i): PickLine => ({ materialId: x.materialId, requiredQty: pickLineRequiredQty(orderQty, x.percentage), ...(mg ? { requiredMg: mg[i]! } : {}), sequenceNo: i + 1 }));
  },
};

let planning: PlanningService;
let picking: PickingService;
let consumption: ConsumptionService;
const U: Record<string, string> = {};

before(async () => {
  await ensureSchema();
  planning = new PlanningService(productionDb(), vault);
  picking = new PickingService(productionDb(), vault);
  consumption = new ConsumptionService(testClient() as never);
  const sql = testClient();
  for (const code of ['g', 'kg', 'mg', 'ml']) {
    await sql`insert into platform.uom_master (uom_code, uom_name, status) values (${code}, ${code}, 'ACTIVE') on conflict (uom_code) do nothing`;
    U[code] = (await sql<{ id: string }[]>`select uom_id::text as id from platform.uom_master where uom_code = ${code}`)[0]!.id;
  }
});
after(async () => { await closeTestClient(); });

function recipe(percentages: number[]) {
  const fv = randomUUID();
  recipes.set(fv, percentages.map((p) => ({ materialId: randomUUID(), percentage: p })));
  return { fv, materials: recipes.get(fv)!.map((x) => x.materialId) };
}

/** A QC-released raw lot (a legacy release on file), kept in g. */
async function lot(materialId: string, grams: number, expiry: string) {
  const sql = testClient();
  const rm = randomUUID(), ib = randomUUID();
  await sql`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, received_qty, uom_id, status)
            values (${rm}, ${materialId}, ${'RM-STK9-' + rm.slice(0, 6)}, ${expiry}, ${grams}, ${U.g!}, 'ACTIVE')`;
  await sql`insert into inventory.lot_qc_event (rm_batch_id, event, detail, actor, at, source, released_at, released_by) values (${rm}, 'LEGACY_RELEASE', 'test fixture', 'test', now(), 'test fixture', now(), 'test')`;
  await sql`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, quantity_on_hand, uom_id, status)
            values (${ib}, ${rm}, ${materialId}, ${grams}, ${U.g!}, 'ACTIVE')`;
  return ib;
}

const lines = async (orderId: string) => testClient()<{ required_mg: string; required_qty: string; reserved_mg: string | null; reserved_batch_id: string | null; uom: string }[]>`
  select i.required_mg::text, i.required_qty::text, i.reserved_mg::text, i.reserved_batch_id::text, u.uom_code as uom
    from production.production_order_ingredients i join platform.uom_master u on u.uom_id = i.uom_id
   where i.production_order_id = ${orderId} order by i.created_dt, i.production_order_ingredient_id`;
const active = async (orderId: string) => testClient()<{ inventory_batch_id: string; reserved_qty: string }[]>`
  select inventory_batch_id::text, reserved_qty::text from inventory.stock_reservation where reserved_for_document_id = ${orderId} and released_dt is null`;

/* ── STK-7 ─────────────────────────────────────────────────────────────────────────────────── */

test('STK-7: split in mg, the lines always total the batch; per-line rounding in kg did not', () => {
  // Made-up shares with two lines whose 5 kg share is a quarter of a gram past a tenth, as in the rehearsal.
  const shares = [49.995, 0.005, 0.005, 25, 24.995];
  const legacyKgMg = shares.reduce((a, p) => a + Math.round(Number(pickLineRequiredQty(5, p)) * 1_000_000), 0);
  assert.notEqual(legacyKgMg, 5_000_000, 'the old per-line rounding in kg does not total 5 kg');
  const mg = pickLinesMg(5_000_000, shares);
  assert.equal(mg.reduce((a, b) => a + b, 0), 5_000_000);
  assert.ok(mg.every((m, i) => Math.abs(m - (5_000_000 * shares[i]!) / 100) < 1), 'each line within 1 mg of its share');
  // Thirds: the leftover mg goes to the largest remainders, earliest line first on a tie.
  assert.deepEqual(pickLinesMg(1_000, [33.333333, 33.333333, 33.333334]), [333, 333, 334]);
  assert.deepEqual(pickLinesMg(100, [33.333333, 33.333333, 33.333334]), [33, 33, 34]);
  assert.equal(pickLinesMg(333_000, [12.345678, 87.654322]).reduce((a, b) => a + b, 0), 333_000);
});

test('STK-7: the same batch ordered in kg and in g has the same lines, to the mg, totalling the order', async () => {
  const { fv } = recipe([49.995, 0.005, 0.005, 25, 24.995]);
  const kg = await planning.createOrder({ formulaVersionId: fv, orderQty: 5, uomId: U.kg }, principal());
  const g = await planning.createOrder({ formulaVersionId: fv, orderQty: 5000, uomId: U.g }, principal());
  const a = await lines(kg.order.productionOrderId), b = await lines(g.order.productionOrderId);
  assert.deepEqual(a.map((l) => l.required_mg), b.map((l) => l.required_mg));
  assert.equal(a.reduce((s, l) => s + Number(l.required_mg), 0), 5_000_000);
  // Stored exactly: in the order's unit where four places hold the line, else in g.
  const f = (u: string) => ({ kg: 1_000_000, g: 1_000, mg: 1 } as Record<string, number>)[u]!;
  assert.ok([...a, ...b].every((l) => Math.round(Number(l.required_qty) * f(l.uom)) === Number(l.required_mg)), 'stored exactly');
  assert.ok(a.some((l) => l.uom === 'g'), 'a 50 mg-step line of a kg order is kept in g, not rounded to 100 mg');
});

/* ── STK-8 ─────────────────────────────────────────────────────────────────────────────────── */

test('STK-8: 333 g now plans (every line a whole mg, total 333,000); a size off the mg grid is refused with the sizes that work', async () => {
  const { fv } = recipe([12.345678, 87.654322]);
  const ok = await planning.createOrder({ formulaVersionId: fv, orderQty: 333, uomId: U.g }, principal());
  assert.equal((await lines(ok.order.productionOrderId)).reduce((s, l) => s + Number(l.required_mg), 0), 333_000);
  await assert.rejects(() => planning.createOrder({ formulaVersionId: fv, orderQty: 0.3333333, uomId: U.g }, principal()),
    (e: unknown) => e instanceof BadRequestException && /0\.333 g or 0\.334 g/.test((e as Error).message));
});

test('STK-8: a batch in ml, or too small for a line to be weighed, is refused at creation, naming no line and no share', async () => {
  const { fv } = recipe([99.999, 0.001]);
  await assert.rejects(() => planning.createOrder({ formulaVersionId: fv, orderQty: 100, uomId: U.ml }, principal()),
    (e: unknown) => e instanceof BadRequestException && /kg, g or mg/.test((e as Error).message));
  await assert.rejects(() => planning.createOrder({ formulaVersionId: fv, orderQty: 10, uomId: U.g }, principal()),
    (e: unknown) => e instanceof BadRequestException && /too small/.test((e as Error).message) && !/0\.001|99\.999|%/.test((e as Error).message));
  const n = await testClient()`select 1 from production.production_order where formula_version_id = ${fv}`;
  assert.equal(n.length, 0, 'nothing was created');
});

/* ── STK-9 ─────────────────────────────────────────────────────────────────────────────────── */

test('STK-9: planning reserves each line on its FEFO lot, in the lot\'s own unit, for the order', async () => {
  const { fv, materials: [m1, m2] } = recipe([80, 20]);
  const early = await lot(m1!, 900, '2027-01-31'), late = await lot(m1!, 900, '2028-01-31');
  const other = await lot(m2!, 500, '2027-06-30');
  const r = await planning.createOrder({ formulaVersionId: fv, orderQty: 1, uomId: U.kg }, principal());
  assert.equal(r.reservation.linesReserved, 2);
  assert.equal(r.reservation.shortLines, 0);
  const held = await active(r.order.productionOrderId);
  assert.deepEqual(held.map((h) => [h.inventory_batch_id, Number(h.reserved_qty)]).sort(), [[early, 800], [other, 200]].sort());
  assert.ok(!held.some((h) => h.inventory_batch_id === late));
});

test('STK-9: a shortfall is known at planning: the order is created SHORT, says so, and the floor top-up refuses until stock arrives', async () => {
  const { fv, materials: [m1] } = recipe([100]);
  await lot(m1!, 400, '2027-01-31');
  const r = await planning.createOrder({ formulaVersionId: fv, orderQty: 1, uomId: U.kg }, principal());
  assert.equal(r.reservation.shortLines, 1);
  assert.match(r.reservation.note!, /needs 1,000,000 mg on one lot and the best lot has 400,000 mg free/);
  assert.equal((await active(r.order.productionOrderId)).length, 0);
  assert.equal((await planning.orderReservation(r.order.productionOrderId)).shortLines, 1);
  assert.equal((await picking.topUpReservations(r.order.productionOrderId, principal().userId)).short.length, 1);
  await lot(m1!, 1200, '2027-03-31'); // stock arrives
  const top = await picking.topUpReservations(r.order.productionOrderId, principal().userId);
  assert.equal(top.short.length, 0);
  assert.equal((await planning.orderReservation(r.order.productionOrderId)).shortLines, 0);
});

test('STK-9: two orders cannot both be promised the same last kilogram, even planned at the same instant', async () => {
  const { fv, materials: [m1] } = recipe([100]);
  const only = await lot(m1!, 1000, '2027-01-31');
  const [a, b] = await Promise.all([
    planning.createOrder({ formulaVersionId: fv, orderQty: 1, uomId: U.kg }, principal()),
    planning.createOrder({ formulaVersionId: fv, orderQty: 1, uomId: U.kg }, principal()),
  ]);
  assert.deepEqual([a.reservation.shortLines, b.reservation.shortLines].sort(), [0, 1]);
  const sum = await testClient()<{ s: string }[]>`select coalesce(sum(reserved_qty), 0)::text as s from inventory.stock_reservation where inventory_batch_id = ${only} and released_dt is null`;
  assert.equal(Number(sum[0]!.s), 1000, 'the lot is held once, never twice');
});

test('STK-9: a cancel releases the reservation, and the next order can then take the stock', async () => {
  const { fv, materials: [m1] } = recipe([100]);
  await lot(m1!, 1000, '2027-01-31');
  const a = await planning.createOrder({ formulaVersionId: fv, orderQty: 1, uomId: U.kg }, principal());
  const b = await planning.createOrder({ formulaVersionId: fv, orderQty: 1, uomId: U.kg }, principal());
  assert.equal(b.reservation.shortLines, 1);
  await assert.rejects(() => planning.cancelOrder(a.order.productionOrderId, '', principal()), ConflictException);
  const c = await planning.cancelOrder(a.order.productionOrderId, 'customer withdrew', principal());
  assert.equal(c.reservationsReleased, 1);
  assert.equal(c.order.status, 'CANCELLED');
  assert.equal((await active(a.order.productionOrderId)).length, 0);
  assert.equal((await picking.topUpReservations(b.order.productionOrderId, principal().userId)).short.length, 0);
});

test('STK-9: the issue converts the planned hold, including on a lot the picker did not take', async () => {
  const { fv, materials: [m1] } = recipe([100]);
  const reservedLot = await lot(m1!, 1000, '2027-01-31');
  const takenLot = await lot(m1!, 1000, '2027-02-28'); // picked off-FEFO, with a reason
  const r = await planning.createOrder({ formulaVersionId: fv, orderQty: 1, uomId: U.kg }, principal());
  assert.equal((await active(r.order.productionOrderId))[0]!.inventory_batch_id, reservedLot);
  const sql = testClient();
  const orderId = r.order.productionOrderId;
  await picking.generatePickList(orderId, {} as never, principal());
  const [pl] = await sql<{ id: string }[]>`select material_pick_list_id::text as id from production.material_pick_list where production_order_id = ${orderId}`;
  const issueId = randomUUID();
  await sql`insert into production.material_issue (material_issue_id, production_order_id, material_pick_list_id, status) values (${issueId}, ${orderId}, ${pl!.id}, 'ACTIVE')`;
  await sql`insert into production.material_issue_item (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status)
            values (${randomUUID()}, ${issueId}, ${m1!}, ${takenLot}, true, 'ACTIVE')`;
  await (consumption as unknown as { applyIssue(id: string): Promise<void> }).applyIssue(issueId);
  assert.equal((await active(orderId)).length, 0, 'no hold outlives the issue');
  const [s] = await sql<{ status: string }[]>`select status from inventory.stock_reservation where reserved_for_document_id = ${orderId}`;
  assert.equal(s!.status, 'CONSUMED');
  const [onHand] = await sql<{ q: string }[]>`select quantity_on_hand::text as q from inventory.inventory_batch where inventory_batch_id = ${takenLot}`;
  assert.equal(Number(onHand!.q), 0);
});
