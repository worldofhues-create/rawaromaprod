/**
 * STOCK-FIX-RP (STK-8, STK-9; LD-19 "reserve at formula grams x batch size").
 *
 * STK-9: a production order reserved nothing when it was planned. The rehearsal's shortfall order (B4)
 * was created, its floor job opened, and only the picker found the shelf short; two orders could both
 * be planned against the same last kilogram. Now planning reserves each line on ONE raw lot, by the
 * rule the floor directs a picker with (floor-station.service.ts PICKABLE_LOTS / directedLot): a
 * QC-released, unheld, unexpired lot of the material, first to expire first, then first received,
 * that holds the whole line after every other active reservation on it. The candidate lots are taken
 * FOR UPDATE in that order before anything is counted, so two plans serialise on the lot and the
 * second sees the first's hold. A line no lot can hold is SHORT at planning (reserved_mg 0); the floor
 * job is refused until it is covered. The reservation is an inventory.stock_reservation row for the
 * order, which the issue at the floor consumes (consumption.service.ts), and a cancel releases.
 *
 * STK-8: an order the floor cannot weigh is refused when it is created, saying what to change. The
 * error never names a material, a share or a percentage: the person planning may not see them.
 */
import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { massFactorMg, mgToQty, qtyToMgExact } from '@core/data-kernel';
import { randomUUID } from 'node:crypto';

export interface ReserveTx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(query: any): Promise<unknown>;
}
async function rows<T>(tx: ReserveTx, q: unknown): Promise<T[]> {
  return Array.from((await tx.execute(q)) as unknown as T[]);
}
const fmt = (mg: number) => `${mg.toLocaleString('en-US')} mg`;

/** The unit code of a uom id (null when there is none or it is unknown). */
export async function uomCode(tx: ReserveTx, uomId: string | null | undefined): Promise<string | null> {
  if (!uomId) return null;
  const [u] = await rows<{ uom_code: string | null }>(tx, sql`select uom_code from platform.uom_master where uom_id = ${uomId}::uuid`);
  return u?.uom_code ?? null;
}

/** The nearest whole-mg sizes either side of a quantity, in its own unit, for the refusal. */
function nearestSizes(qty: number, code: string): string {
  const f = massFactorMg(code)!;
  const mg = (qty * f);
  const lo = Math.floor(mg), hi = Math.ceil(mg);
  return [lo, hi].filter((v, i, a) => v > 0 && a.indexOf(v) === i).map((v) => `${mgToQty(v, code) ? Number(mgToQty(v, code)) : v / f} ${code}`).join(' or ');
}

/**
 * An order's size in integer mg, or a refusal that says what to change. A batch is weighed, so its
 * unit is a mass; an order with no unit keeps the old path (the floor refuses it, as before).
 */
export async function orderSizeMg(tx: ReserveTx, orderQty: number, uomId: string | null | undefined): Promise<number | null> {
  if (!uomId) return null;
  const code = await uomCode(tx, uomId);
  if (!code) throw new BadRequestException('The order\'s unit is not on file. Order the batch in kg, g or mg.');
  if (massFactorMg(code) === null) {
    throw new BadRequestException(`A batch is weighed, so it cannot be ordered in ${code}. Order it in kg, g or mg.`);
  }
  const mg = qtyToMgExact(String(orderQty), code);
  if (mg === null) {
    throw new BadRequestException(`${orderQty} ${code} is not a whole number of mg, which the scales cannot weigh. Order ${nearestSizes(orderQty, code)}.`);
  }
  return mg;
}

/** Refuse a split the floor cannot weigh: a line of 0 mg means the batch is too small. */
export function assertWeighable(lineMg: number[]): void {
  if (lineMg.some((mg) => !(mg > 0))) {
    throw new BadRequestException('This batch is too small for every line to be weighed: at least one line would be under 1 mg. Make the batch larger.');
  }
}

interface Lot { inventory_batch_id: string; qty: string; uom_code: string | null }

/** The lots the floor would direct a picker to for a material, in the floor's order, locked. */
async function pickableLotsLocked(tx: ReserveTx, materialId: string): Promise<Lot[]> {
  return rows<Lot>(tx, sql`
    select ib.inventory_batch_id::text, ib.quantity_on_hand::text as qty, u.uom_code
      from inventory.inventory_batch ib
      join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
      left join platform.uom_master u on u.uom_id = ib.uom_id
     where ib.material_id = ${materialId}::uuid and ib.quantity_on_hand > 0
       and upper(coalesce(inventory.rm_lot_qc_result(ib.rm_batch_id), '')) in ('ACCEPT', 'PASS', 'LEGACY_RELEASE')
       and upper(coalesce(rb.status, '')) not in ('QUARANTINE', 'REJECTED', 'HOLD')
       and not exists (select 1 from inventory.lot_hold h where h.subject_type = 'RM_LOT' and h.subject_id = ib.rm_batch_id and h.released_dt is null)
       and (rb.expiry_date is null or rb.expiry_date >= current_date)
     order by rb.expiry_date asc nulls last, rb.created_dt asc, rb.batch_number asc nulls last, ib.inventory_batch_id
       for update of ib`);
}

/** Active holds on a lot, in mg; a hold that does not convert exactly counts as the whole lot. */
export async function heldMg(tx: ReserveTx, batchId: string, lotUom: string | null, exceptDocumentId?: string | null): Promise<number> {
  const held = await rows<{ qty: string | null; uom: string | null }>(tx, sql`
    select r.reserved_qty::text as qty, coalesce(ru.uom_code, ${lotUom}) as uom
      from inventory.stock_reservation r left join platform.uom_master ru on ru.uom_id = r.uom_id
     where r.inventory_batch_id = ${batchId}::uuid and r.released_dt is null
       ${exceptDocumentId ? sql`and r.reserved_for_document_id is distinct from ${exceptDocumentId}::uuid` : sql``}`);
  let mg = 0;
  for (const h of held) {
    const v = qtyToMgExact(h.qty, h.uom);
    if (v === null) return Number.MAX_SAFE_INTEGER; // a hold we cannot read: nothing on this lot is free
    mg += v;
  }
  return mg;
}

export interface Shortfall { productionOrderIngredientId: string; materialId: string; line: number; needMg: number; bestLotFreeMg: number }

/**
 * Reserve every unreserved mg line of an order (one lot per line). Returns the lines still short.
 * Idempotent: a line already reserved is left alone.
 */
export async function reserveOrderTx(tx: ReserveTx, productionOrderId: string, userId: string): Promise<{ reserved: number; short: Shortfall[] }> {
  const lines = await rows<{ id: string; material_id: string; required_mg: string; reserved_mg: string | null }>(tx, sql`
    select production_order_ingredient_id::text as id, material_id::text, required_mg::text, reserved_mg::text
      from production.production_order_ingredients
     where production_order_id = ${productionOrderId}::uuid and required_mg is not null and material_id is not null
     order by created_dt, production_order_ingredient_id
       for update`);
  let reserved = 0;
  const short: Shortfall[] = [];
  for (const [i, l] of lines.entries()) {
    const need = Number(l.required_mg);
    if (Number(l.reserved_mg ?? 0) >= need) continue;
    let best = 0, done = false;
    for (const lot of await pickableLotsLocked(tx, l.material_id)) {
      const onHand = qtyToMgExact(lot.qty, lot.uom_code);
      if (onHand === null) continue; // a lot not in a mass unit cannot be weighed from
      const free = onHand - (await heldMg(tx, lot.inventory_batch_id, lot.uom_code));
      best = Math.max(best, free);
      const inLot = mgToQty(need, lot.uom_code);
      if (free >= need && inLot !== null) {
        await tx.execute(sql`
          insert into inventory.stock_reservation (stock_reservation_id, inventory_batch_id, reserved_qty, uom_id, reserved_for_document_id, reserved_dt, status, created_by, updated_by)
          values (${randomUUID()}, ${lot.inventory_batch_id}::uuid, ${inLot}::numeric,
                  (select uom_id from inventory.inventory_batch where inventory_batch_id = ${lot.inventory_batch_id}::uuid),
                  ${productionOrderId}::uuid, now(), 'ACTIVE', ${userId}, ${userId})`);
        await tx.execute(sql`
          update production.production_order_ingredients set reserved_mg = ${need}, reserved_batch_id = ${lot.inventory_batch_id}::uuid, updated_by = ${userId}
           where production_order_ingredient_id = ${l.id}::uuid`);
        reserved++;
        done = true;
        break;
      }
    }
    if (!done) {
      await tx.execute(sql`update production.production_order_ingredients set reserved_mg = 0 where production_order_ingredient_id = ${l.id}::uuid and reserved_mg is null`);
      short.push({ productionOrderIngredientId: l.id, materialId: l.material_id, line: i + 1, needMg: need, bestLotFreeMg: Math.max(0, best) });
    }
  }
  return { reserved, short };
}

/** Release an order's open reservations (a cancel). Returns how many were released. */
export async function releaseOrderTx(tx: ReserveTx, productionOrderId: string, userId: string, status: 'RELEASED' | 'CONSUMED' = 'RELEASED'): Promise<number> {
  const out = await rows<{ id: string }>(tx, sql`
    update inventory.stock_reservation set released_dt = now(), status = ${status}, updated_by = ${userId}, updated_dt = now()
     where reserved_for_document_id = ${productionOrderId}::uuid and released_dt is null
     returning stock_reservation_id::text as id`);
  await tx.execute(sql`update production.production_order_ingredients set reserved_mg = 0, reserved_batch_id = null
                        where production_order_id = ${productionOrderId}::uuid and required_mg is not null`);
  return out.length;
}

/** The plain-language shortfall, for the order's response and the floor's refusal. No names. */
export function shortfallText(short: Shortfall[]): string {
  return short.map((s) => `line ${s.line} needs ${fmt(s.needMg)} on one lot and the best lot has ${fmt(s.bestLotFreeMg)} free`).join('; ');
}

