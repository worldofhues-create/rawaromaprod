/**
 * Lane produce test fixtures — the chain a finished-good label, a put-away and a pick walk:
 * product (+ SKU, pack size) → production order → oil batch → batch COA (tested / released /
 * rejected) → package order → finished-good batch, and a rack of bins. Direct SQL (the services
 * under test are the ones that READ this chain); every code is unique per call so the shared,
 * reused test database never collides.
 */
import { randomUUID } from 'node:crypto';
import { testClient } from './db.js';

/** The `kg` unit (created once; uom_code is unique). */
export async function kgUom(): Promise<string> {
  const sql = testClient();
  await sql`insert into platform.uom_master (uom_id, uom_code, uom_name) values (${randomUUID()}, 'kg', 'Kilogram')
            on conflict (uom_code) do nothing`;
  return (await sql`select uom_id::text from platform.uom_master where uom_code = 'kg'`)[0]!.uom_id as string;
}

/** A unit that is NOT a mass (drums / pieces), unique per call. */
export async function eachUom(): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = `EA-${id.slice(0, 6)}`;
  await testClient()`insert into platform.uom_master (uom_id, uom_code, uom_name) values (${id}, ${code}, 'Each')`;
  return { id, code };
}

export interface ProductFixture {
  productId: string;
  productCode: string;
  productName: string;
  formulaId: string;
  skuId: string;
  skuCode: string;
  packSize: string;
}

export async function productWithSku(opts: { packSize?: string; formulaId?: string | null; name?: string } = {}): Promise<ProductFixture> {
  const sql = testClient();
  const productId = randomUUID();
  const productCode = `PRD-${productId.slice(0, 8)}`;
  const formulaId = opts.formulaId === null ? null : opts.formulaId ?? randomUUID();
  const productName = opts.name ?? 'Althair';
  await sql`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status)
            values (${productId}, ${formulaId}, ${productCode}, ${productName}, 'ACTIVE')`;
  const skuId = randomUUID();
  const packSize = opts.packSize ?? '25 kg';
  const skuCode = `${productCode}-${packSize.replace(/\s+/g, '').toUpperCase()}`;
  await sql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status)
            values (${skuId}, ${productId}, ${skuCode}, ${packSize}, 'ACTIVE')`;
  return { productId, productCode, productName, formulaId: formulaId as string, skuId, skuCode, packSize };
}

export type CoaState = 'NONE' | 'TESTED_PASS' | 'TESTED_FAIL' | 'RELEASED' | 'REJECTED';

export interface FgFixture extends ProductFixture {
  productionOrderId: string;
  oilBatchId: string;
  oilBatchNo: string;
  batchCoaId: string | null;
  packageOrderId: string;
  fgBatchId: string;
  fgBatchNo: string;
  uomId: string;
  releasedAt: string | null;
}

/**
 * A finished-good batch at the end of the chain, with its oil batch's COA in `coa` state.
 * `qty` units of `uom` (default: 4 drums of the SKU's 25 kg pack — 100 kg).
 */
export async function finishedGood(opts: {
  coa?: CoaState;
  product?: ProductFixture;
  qty?: number;
  uomId?: string;
  manufacturingDate?: string;
  expiryDate?: string | null;
  productionOrderId?: string;
} = {}): Promise<FgFixture> {
  const sql = testClient();
  const product = opts.product ?? (await productWithSku());
  const productionOrderId = opts.productionOrderId ?? randomUUID();
  if (!opts.productionOrderId) {
    await sql`insert into production.production_order (production_order_id, order_qty, status) values (${productionOrderId}, 100, 'COMPLETED')`;
  }
  const oilBatchId = randomUUID();
  const oilBatchNo = `A${oilBatchId.slice(0, 7)}`;
  await sql`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, produced_qty, produced_dt, status)
            values (${oilBatchId}, ${productionOrderId}, ${oilBatchNo}, 100, '2026-09-20T08:00:00Z', 'RELEASED')`;
  const coa = opts.coa ?? 'RELEASED';
  let batchCoaId: string | null = null;
  let releasedAt: string | null = null;
  if (coa !== 'NONE') {
    batchCoaId = randomUUID();
    const pass = coa !== 'TESTED_FAIL';
    const status = coa === 'RELEASED' ? 'RELEASED' : coa === 'REJECTED' ? 'REJECTED' : 'TESTED';
    releasedAt = coa === 'RELEASED' ? '2026-09-21T09:30:00.000Z' : null;
    const who = randomUUID();
    await sql`insert into production.batch_coa
      (batch_coa_id, oil_batch_id, product_id, sg_result, sg_spec_min, sg_spec_max, sg_pass,
       flash_point_result_c, flash_point_spec_min_c, flash_point_spec_max_c, flash_point_pass,
       colour_appearance, colour_appearance_pass, odour_description, odour_pass, production_date, best_before,
       overall_result, tested_by, released_by, released_dt, rejected_by, rejected_dt, reject_reason, status)
      values (${batchCoaId}, ${oilBatchId}, ${product.productId}, 0.995, 0.95, 1.5, true,
       ${pass ? 116 : 125}, 110, 120, ${pass}, 'Deep Brown', true, 'Warm Spicy Vanilla', true, '2026-09-20', '2028-09-20',
       ${pass ? 'PASS' : 'FAIL'}, ${who}, ${status === 'RELEASED' ? who : null}, ${releasedAt},
       ${status === 'REJECTED' ? who : null}, ${status === 'REJECTED' ? '2026-09-21T09:30:00Z' : null},
       ${status === 'REJECTED' ? 'contaminated' : null}, ${status})`;
  }
  const packageOrderId = randomUUID();
  await sql`insert into packaging.package_order (package_order_id, product_sku_id, oil_batch_id, order_qty, status)
            values (${packageOrderId}, ${product.skuId}, ${oilBatchId}, 4, 'COMPLETED')`;
  const uomId = opts.uomId ?? (await eachUom()).id;
  const fgBatchId = randomUUID();
  const fgBatchNo = `FG-${fgBatchId.slice(0, 8)}`;
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, package_order_id, product_sku_id, batch_number, produced_qty, uom_id, manufacturing_date, expiry_date, status)
    values (${fgBatchId}, ${packageOrderId}, ${product.skuId}, ${fgBatchNo}, ${opts.qty ?? 4}, ${uomId},
            ${opts.manufacturingDate ?? '2026-09-22'}, ${opts.expiryDate === undefined ? '2028-09-20' : opts.expiryDate}, 'ACTIVE')`;
  return { ...product, productionOrderId, oilBatchId, oilBatchNo, batchCoaId, packageOrderId, fgBatchId, fgBatchNo, uomId, releasedAt };
}

export interface RackFixture {
  zoneCode: string;
  rackCode: string;
  bins: string[];
}

/** A rack of `shelves` × `bins` in a new zone, codes `<rack>-S<n>-B<m>`, walk order `walkSeq`. */
export async function rack(opts: { shelves?: number; bins?: number; walkSeq?: number; zoneCode?: string } = {}): Promise<RackFixture> {
  const sql = testClient();
  const id = randomUUID().slice(0, 6).toUpperCase();
  const zoneCode = opts.zoneCode ?? `Z${id}`;
  let zone = (await sql`select zone_id::text from location.zone_master where zone_code = ${zoneCode}`)[0];
  if (!zone) zone = (await sql`insert into location.zone_master (zone_code, zone_name, status) values (${zoneCode}, 'Test zone', 'ACTIVE') returning zone_id::text`)[0];
  const rackCode = `R${id}`;
  const r = (await sql`insert into location.rack_master (zone_id, rack_code, status) values (${zone!.zone_id}, ${rackCode}, 'ACTIVE') returning rack_id::text`)[0]!;
  if (opts.walkSeq !== undefined) await sql`insert into location.rack_walk_order (rack_id, walk_seq) values (${r.rack_id}, ${opts.walkSeq})`;
  const bins: string[] = [];
  for (let s = 1; s <= (opts.shelves ?? 2); s++) {
    const sh = (await sql`insert into location.shelf_master (rack_id, shelf_code, status) values (${r.rack_id}, ${`${rackCode}-S${s}`}, 'ACTIVE') returning shelf_id::text`)[0]!;
    for (let b = 1; b <= (opts.bins ?? 2); b++) {
      const code = `${rackCode}-S${s}-B${b}`;
      await sql`insert into location.bin_master (shelf_id, bin_code, status) values (${sh.shelf_id}, ${code}, 'ACTIVE')`;
      bins.push(code);
    }
  }
  return { zoneCode, rackCode, bins };
}

/** An ACCEPTED ALEMBIC requirement row (as the importer leaves it), optionally linked to a run. */
export async function requirement(opts: {
  sku: string;
  qtyKg?: number;
  neededBy?: string;
  rank?: number | null;
  reason?: string | null;
  valueInr?: number | null;
  productionOrderId?: string | null;
  status?: string;
  packSize?: string | null;
}): Promise<{ id: string; correlationId: string; orgId: string }> {
  const id = randomUUID();
  const correlationId = randomUUID();
  const orgId = randomUUID();
  await testClient()`insert into bridge.production_requirement
    (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, pack_size, needed_by, priority,
     priority_rank, priority_reason, order_value_inr, order_refs, qty_kg, lot_policy, lifecycle_status, production_order_id,
     last_applied_version, last_emitted_version)
    values (${id}, ${orgId}, ${correlationId}, ${`SO-${id.slice(0, 6)}`}, ${opts.sku}, ${opts.qtyKg ?? 50}, 'kg', ${opts.packSize ?? '25 kg'},
            ${opts.neededBy ?? '2099-01-01T00:00:00Z'}, ${opts.reason ?? 'normal'}, ${opts.rank ?? null}, ${opts.reason ?? null},
            ${opts.valueInr ?? null}, ${JSON.stringify([`SO-${id.slice(0, 6)}`])}::jsonb, ${opts.qtyKg ?? 50}, 'fifo',
            ${opts.status ?? 'ACCEPTED'}, ${opts.productionOrderId ?? null}, 1, 1)`;
  return { id, correlationId, orgId };
}
