/**
 * STOCK-FIX-RP (STK-10, STK-11; LD-19 "stock is one equation"): the oil a batch made, as a stock that
 * moves, in integer milligrams.
 *
 * Before this the finished side of the equation was recorded nowhere. `oil_batch_master.produced_qty`
 * was the sum of the weighed lines and nothing drew it down: the rehearsal packed 700,000 mg from an
 * oil batch of 499,676 mg, and a QC-failed batch's 999,345 mg simply stayed "made". Now:
 *
 *   MADE           + the sum of the weighed lines, once per batch (production's produceOilBatch)
 *   PACKED         - packs filled x the pack's net content (packaging's recordFilling)
 *   PACK_REJECTED  - packs filled and rejected x net content: the oil is in a reject, not in the batch
 *   LOSS           - book remaining less what the scale reads at a remnant count, with a reason
 *   WRITE_OFF      - a remnant or a failed batch written off, with a reason, by a named role
 *
 *   remaining = sum(delta_mg). A package order may not promise, and a fill may not draw, more than
 *   remains. Every caller passes its own transaction: several clusters move the same oil, and none may
 *   import another (the same reason maceration-gate.ts lives in the kernel).
 *
 * The oil row is locked FOR UPDATE before a balance that a write depends on is read, so two fills or
 * two package orders on one batch are serialised and cannot both spend the same last gram.
 */
import { ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { qtyToMgExact, massFactorMg } from '@core/data-kernel';

export interface StockTx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(query: any): Promise<unknown>;
}

async function rows<T>(tx: StockTx, q: unknown): Promise<T[]> {
  return Array.from((await tx.execute(q)) as unknown as T[]);
}

/** Who did it, as the ledger records it: the user and the roles they acted under. */
export interface Actor { userId: string; roles?: string[] }
const roleText = (a: Actor) => (a.roles && a.roles.length ? a.roles.join(',').slice(0, 200) : null);

export interface OilBalance {
  oilBatchId: string;
  batchNumber: string | null;
  status: string | null;
  /** null: no MADE row, so the oil was never measured and nothing may be packed from it. */
  madeMg: number | null;
  packedMg: number;
  rejectedMg: number;
  lossMg: number;
  writtenOffMg: number;
  remainingMg: number | null;
  /** Ordered on open package orders and not yet filled: oil promised but still in the batch. */
  committedMg: number;
  /** remaining - committed: what a new package order may take. */
  freeMg: number | null;
  /** The floor's formula target for the batch, when it was made on the floor (sum of line targets). */
  targetMg: number | null;
  /** packed / made, basis points (9,006 = 90.06 %). Null while nothing is made. */
  yieldBp: number | null;
  remnant: { disposition: 'KEEP' | 'HOLD' | 'WRITE_OFF'; weighedMg: number; bookMg: number; lossMg: number; reason: string | null; decidedBy: string; decidedRole: string | null; decidedDt: string } | null;
}

const OPEN_ORDER = ['DRAFT', 'MATERIALS_ISSUED', 'IN_PROGRESS'];

/** The balance of one oil batch. `lock` takes the oil row FOR UPDATE first (any caller about to write). */
export async function oilBalance(tx: StockTx, oilBatchId: string, opts: { lock?: boolean; excludePackageOrderId?: string } = {}): Promise<OilBalance | null> {
  const [ob] = await rows<{ oil_batch_id: string; batch_number: string | null; status: string | null }>(tx, opts.lock
    ? sql`select oil_batch_id::text, batch_number, status from production.oil_batch_master where oil_batch_id = ${oilBatchId}::uuid for update`
    : sql`select oil_batch_id::text, batch_number, status from production.oil_batch_master where oil_batch_id = ${oilBatchId}::uuid`);
  if (!ob) return null;
  const [m] = await rows<{ made: string | null; packed: string; rejected: string; loss: string; written: string; total: string; n_made: number }>(tx, sql`
    select sum(delta_mg) filter (where kind = 'MADE')::text as made,
           coalesce(-sum(delta_mg) filter (where kind = 'PACKED'), 0)::text as packed,
           coalesce(-sum(delta_mg) filter (where kind = 'PACK_REJECTED'), 0)::text as rejected,
           coalesce(-sum(delta_mg) filter (where kind = 'LOSS'), 0)::text as loss,
           coalesce(-sum(delta_mg) filter (where kind = 'WRITE_OFF'), 0)::text as written,
           coalesce(sum(delta_mg), 0)::text as total,
           count(*) filter (where kind = 'MADE')::int as n_made
      from production.oil_batch_movement where oil_batch_id = ${oilBatchId}::uuid`);
  const made = m && m.n_made > 0 ? Number(m.made) : null;
  // Oil still promised to open package orders: each order's ordered mass less what it already drew.
  const open = await rows<{ package_order_id: string; order_qty: string | null; uom_id: string | null; product_sku_id: string | null; drawn: string }>(tx, sql`
    select po.package_order_id::text, po.order_qty::text, po.uom_id::text, po.product_sku_id::text,
           coalesce((select -sum(mv.delta_mg) from production.oil_batch_movement mv
                      where mv.package_order_id = po.package_order_id and mv.kind in ('PACKED', 'PACK_REJECTED')), 0)::text as drawn
      from packaging.package_order po
     where po.oil_batch_id = ${oilBatchId}::uuid and upper(coalesce(po.status, 'DRAFT')) in (${sql.join(OPEN_ORDER.map((s) => sql`${s}`), sql`, `)})
       ${opts.excludePackageOrderId ? sql`and po.package_order_id <> ${opts.excludePackageOrderId}::uuid` : sql``}`);
  let committed = 0;
  for (const o of open) {
    const mass = await packMassMg(tx, { productSkuId: o.product_sku_id, qty: o.order_qty, uomId: o.uom_id });
    if ('mg' in mass) committed += Math.max(0, mass.mg - Number(o.drawn));
  }
  const [t] = await rows<{ target: string | null }>(tx, sql`
    select sum(fl.target_mg)::text as target from production.floor_job j join production.floor_line fl on fl.floor_job_id = j.floor_job_id
     where j.oil_batch_id = ${oilBatchId}::uuid`);
  const [r] = await rows<{ disposition: 'KEEP' | 'HOLD' | 'WRITE_OFF'; weighed_mg: string; book_mg: string; loss_mg: string; reason: string | null; decided_by: string; decided_role: string | null; decided_dt: string }>(tx, sql`
    select disposition, weighed_mg::text, book_mg::text, loss_mg::text, reason, decided_by, decided_role, decided_dt::text
      from production.oil_batch_remnant where oil_batch_id = ${oilBatchId}::uuid order by decided_dt desc, oil_batch_remnant_id desc limit 1`);
  const remaining = made === null ? null : Number(m!.total);
  const packed = Number(m?.packed ?? 0);
  return {
    oilBatchId: ob.oil_batch_id, batchNumber: ob.batch_number, status: ob.status,
    madeMg: made, packedMg: packed, rejectedMg: Number(m?.rejected ?? 0), lossMg: Number(m?.loss ?? 0), writtenOffMg: Number(m?.written ?? 0),
    remainingMg: remaining, committedMg: committed, freeMg: remaining === null ? null : remaining - committed,
    targetMg: t?.target != null ? Number(t.target) : null,
    yieldBp: made ? Math.round((packed * 10000) / made) : null,
    remnant: r ? { disposition: r.disposition, weighedMg: Number(r.weighed_mg), bookMg: Number(r.book_mg), lossMg: Number(r.loss_mg), reason: r.reason, decidedBy: r.decided_by, decidedRole: r.decided_role, decidedDt: r.decided_dt } : null,
  };
}

/** One pack's net content: the SKU's own `net_content_mg`, else its pack size when that is a plain mass. */
export async function skuNetContentMg(tx: StockTx, productSkuId: string | null | undefined): Promise<{ mg: number } | { refused: string }> {
  if (!productSkuId) return { refused: 'The package order names no SKU, so the net content of a pack is not known.' };
  const [s] = await rows<{ sku_code: string | null; pack_size: string | null; net_content_mg: string | null }>(tx, sql`
    select sku_code, pack_size, net_content_mg::text from packaging.product_sku where product_sku_id = ${productSkuId}::uuid`);
  if (!s) return { refused: `SKU ${productSkuId} is not on file, so the net content of a pack is not known.` };
  if (s.net_content_mg != null) return { mg: Number(s.net_content_mg) };
  const mg = parsePackSizeMg(s.pack_size);
  if (mg !== null) return { mg };
  return { refused: `SKU ${s.sku_code ?? productSkuId} has no net content on file${s.pack_size ? ` and its pack size "${s.pack_size}" is not a plain mass` : ''}: set netContentMg on the SKU before packing, so the oil can be drawn down.` };
}

/** "100 g", "0.5 kg", "250mg" -> exact integer mg; anything else (ml, "100 g bottle") -> null. */
export function parsePackSizeMg(packSize: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$/.exec(String(packSize ?? ''));
  if (!m || massFactorMg(m[2]) === null) return null;
  const mg = qtyToMgExact(m[1], m[2]);
  return mg !== null && mg > 0 ? mg : null;
}

/** The oil a quantity of packs (or a mass) takes, in mg. A mass unit is exact; a count, or no unit,
 *  is packs x the SKU's net content. Whole packs only: there is no part of a bottle. */
export async function packMassMg(tx: StockTx, a: { productSkuId: string | null | undefined; qty: string | number | null | undefined; uomId: string | null | undefined }): Promise<{ mg: number } | { refused: string }> {
  if (a.qty == null || String(a.qty).trim() === '') return { mg: 0 };
  let code: string | null = null;
  if (a.uomId) {
    const [u] = await rows<{ uom_code: string | null }>(tx, sql`select uom_code from platform.uom_master where uom_id = ${a.uomId}::uuid`);
    code = u?.uom_code ?? null;
  }
  if (code && massFactorMg(code) !== null) {
    const mg = qtyToMgExact(String(a.qty), code);
    return mg === null ? { refused: `${a.qty} ${code} is not a whole number of mg.` } : { mg };
  }
  const n = Number(a.qty);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { refused: `${a.qty} is not a whole number of packs.` };
  if (n === 0) return { mg: 0 };
  const net = await skuNetContentMg(tx, a.productSkuId);
  return 'refused' in net ? net : { mg: n * net.mg };
}

const fmt = (mg: number) => `${mg.toLocaleString('en-US')} mg`;

/** MADE: once per batch, the mass the floor weighed into it. */
export async function recordOilMade(tx: StockTx, a: { oilBatchId: string; madeMg: number; actor: Actor }) {
  if (!Number.isSafeInteger(a.madeMg) || a.madeMg < 0) throw new ConflictException(`An oil batch is made of a whole number of mg, not ${a.madeMg}.`);
  await tx.execute(sql`
    insert into production.oil_batch_movement (oil_batch_movement_id, oil_batch_id, kind, delta_mg, recorded_by, recorded_role)
    values (${randomUUID()}, ${a.oilBatchId}::uuid, 'MADE', ${a.madeMg}, ${a.actor.userId}, ${roleText(a.actor)})`);
}

/** Refuse a package order that promises more oil than is free on the batch (locks the oil row). */
export async function assertOilCanCover(tx: StockTx, a: { oilBatchId: string; productSkuId: string | null | undefined; orderQty: string | number | null | undefined; uomId: string | null | undefined; excludePackageOrderId?: string }) {
  const need = await packMassMg(tx, { productSkuId: a.productSkuId, qty: a.orderQty, uomId: a.uomId });
  if ('refused' in need) throw new ConflictException(`Cannot size this package order against the oil: ${need.refused}`);
  const bal = await oilBalance(tx, a.oilBatchId, { lock: true, excludePackageOrderId: a.excludePackageOrderId });
  if (!bal) throw new ConflictException(`Oil batch ${a.oilBatchId} is not on file.`);
  if (bal.remainingMg === null) throw new ConflictException(`Oil batch ${bal.batchNumber ?? a.oilBatchId} has no made quantity on the oil ledger, so nothing can be packed from it until it is measured.`);
  if (bal.remnant?.disposition === 'HOLD') throw new ConflictException(`Oil batch ${bal.batchNumber ?? a.oilBatchId}'s remnant is on hold (${bal.remnant.reason ?? 'no reason given'}): decide it before packing more.`);
  if (need.mg > (bal.freeMg ?? 0)) {
    throw new ConflictException(
      `Oil batch ${bal.batchNumber ?? a.oilBatchId} holds ${fmt(bal.remainingMg)}${bal.committedMg ? `, ${fmt(bal.committedMg)} of it already promised to open package orders` : ''}; `
        + `this order needs ${fmt(need.mg)}, ${fmt(need.mg - (bal.freeMg ?? 0))} more than is free. Order fewer packs.`,
    );
  }
  return { needMg: need.mg, balance: bal };
}

/** PACKED and PACK_REJECTED for one filling record, refused when they exceed what remains. */
export async function recordOilPacked(tx: StockTx, a: { oilBatchId: string; packageOrderId: string; productSkuId: string | null | undefined; fillingSessionDetailId: string; filledQty: string | number | null | undefined; rejectedQty: string | number | null | undefined; uomId: string | null | undefined; actor: Actor }) {
  const filled = await packMassMg(tx, { productSkuId: a.productSkuId, qty: a.filledQty, uomId: a.uomId });
  if ('refused' in filled) throw new ConflictException(`Cannot draw the oil down for this fill: ${filled.refused}`);
  const rejected = await packMassMg(tx, { productSkuId: a.productSkuId, qty: a.rejectedQty, uomId: a.uomId });
  if ('refused' in rejected) throw new ConflictException(`Cannot draw the oil down for the rejected packs: ${rejected.refused}`);
  const bal = await oilBalance(tx, a.oilBatchId, { lock: true });
  if (!bal) throw new ConflictException(`Oil batch ${a.oilBatchId} is not on file.`);
  if (bal.remainingMg === null) throw new ConflictException(`Oil batch ${bal.batchNumber ?? a.oilBatchId} has no made quantity on the oil ledger, so nothing can be packed from it until it is measured.`);
  if (bal.remnant?.disposition === 'HOLD') throw new ConflictException(`Oil batch ${bal.batchNumber ?? a.oilBatchId}'s remnant is on hold: decide it before packing more.`);
  const draw = filled.mg + rejected.mg;
  if (draw > bal.remainingMg) {
    throw new ConflictException(
      `Oil batch ${bal.batchNumber ?? a.oilBatchId} holds ${fmt(bal.remainingMg)}; this fill draws ${fmt(draw)} (${fmt(filled.mg)} filled${rejected.mg ? `, ${fmt(rejected.mg)} rejected` : ''}), `
        + `${fmt(draw - bal.remainingMg)} more than the batch holds. Record what was really filled.`,
    );
  }
  for (const [kind, mg] of [['PACKED', filled.mg], ['PACK_REJECTED', rejected.mg]] as const) {
    if (mg <= 0) continue;
    await tx.execute(sql`
      insert into production.oil_batch_movement (oil_batch_movement_id, oil_batch_id, kind, delta_mg, package_order_id, ref_id, recorded_by, recorded_role)
      values (${randomUUID()}, ${a.oilBatchId}::uuid, ${kind}, ${-mg}, ${a.packageOrderId}::uuid, ${a.fillingSessionDetailId}::uuid, ${a.actor.userId}, ${roleText(a.actor)})`);
  }
  return { filledMg: filled.mg, rejectedMg: rejected.mg, remainingMg: bal.remainingMg - draw };
}

export type RemnantDisposition = 'KEEP' | 'HOLD' | 'WRITE_OFF';

/**
 * A remnant count: what the scale reads against what the book holds. The difference is a LOSS (with a
 * reason). KEEP leaves the remnant packable later; HOLD stops packing until it is decided again;
 * WRITE_OFF takes it off the ledger (reason, and the caller holds the write-off permission). A count
 * above the book is refused: a count that does not match is raised, never adjusted quietly (LD-19).
 * A FAILED batch cannot be kept to pack: it is held or written off.
 */
export async function recordRemnant(tx: StockTx, a: { oilBatchId: string; weighedMg: number; disposition: RemnantDisposition; reason?: string | null; actor: Actor }) {
  if (!Number.isSafeInteger(a.weighedMg) || a.weighedMg < 0) throw new ConflictException('The scale reading is a whole number of mg, 0 or more.');
  const reason = String(a.reason ?? '').trim() || null;
  const bal = await oilBalance(tx, a.oilBatchId, { lock: true });
  if (!bal) throw new ConflictException(`Oil batch ${a.oilBatchId} is not on file.`);
  if (bal.remainingMg === null) throw new ConflictException(`Oil batch ${bal.batchNumber ?? a.oilBatchId} has no made quantity on the oil ledger, so there is no book to count against.`);
  const name = bal.batchNumber ?? a.oilBatchId;
  if (a.weighedMg > bal.remainingMg) {
    throw new ConflictException(`The scale reads ${fmt(a.weighedMg)} but oil batch ${name} holds ${fmt(bal.remainingMg)} on the book: ${fmt(a.weighedMg - bal.remainingMg)} more than was made less what was packed. Re-weigh; a count above the book is raised with production, never booked.`);
  }
  if (a.disposition === 'KEEP' && String(bal.status ?? '').toUpperCase() === 'FAILED') {
    throw new ConflictException(`Oil batch ${name} FAILED QC, so its oil cannot be kept to pack: hold it or write it off.`);
  }
  if (bal.committedMg > 0 && a.disposition !== 'KEEP') {
    throw new ConflictException(`Oil batch ${name} still has ${fmt(bal.committedMg)} promised to open package orders: complete or cancel them before holding or writing off the remnant.`);
  }
  const loss = bal.remainingMg - a.weighedMg;
  if ((loss > 0 || a.disposition === 'WRITE_OFF') && !reason) {
    throw new ConflictException(loss > 0
      ? `The count is ${fmt(loss)} under the book: a loss needs a reason (spillage, residue in the vessel, evaporation).`
      : 'A write-off needs a reason.');
  }
  if (loss > 0) {
    await tx.execute(sql`
      insert into production.oil_batch_movement (oil_batch_movement_id, oil_batch_id, kind, delta_mg, reason, recorded_by, recorded_role)
      values (${randomUUID()}, ${a.oilBatchId}::uuid, 'LOSS', ${-loss}, ${reason}, ${a.actor.userId}, ${roleText(a.actor)})`);
  }
  if (a.disposition === 'WRITE_OFF' && a.weighedMg > 0) {
    await tx.execute(sql`
      insert into production.oil_batch_movement (oil_batch_movement_id, oil_batch_id, kind, delta_mg, reason, recorded_by, recorded_role)
      values (${randomUUID()}, ${a.oilBatchId}::uuid, 'WRITE_OFF', ${-a.weighedMg}, ${reason}, ${a.actor.userId}, ${roleText(a.actor)})`);
  }
  await tx.execute(sql`
    insert into production.oil_batch_remnant (oil_batch_remnant_id, oil_batch_id, weighed_mg, book_mg, loss_mg, disposition, reason, decided_by, decided_role)
    values (${randomUUID()}, ${a.oilBatchId}::uuid, ${a.weighedMg}, ${bal.remainingMg}, ${loss}, ${a.disposition}, ${reason}, ${a.actor.userId}, ${roleText(a.actor)})`);
  return oilBalance(tx, a.oilBatchId);
}
