/**
 * IMPORT-RP — the factory's import kinds: how each judges a row, and how each writes one.
 *
 * JUDGING reads the database and writes nothing. Every problem in a row is reported, in a sentence,
 * with nothing guessed: an empty hazard class stays empty, an expiry that is not printed stays null,
 * a quantity without a unit that converts exactly is refused.
 *
 * WRITING calls the function the single-record route calls, bound to the import's transaction
 * (`asPool`: the service's own transaction becomes a savepoint), as PROD-B already does with
 * GrnService:
 *
 *   ingredients           MaterialImportService.writeRow -> MaterialService.createMaterial (POST /v1/materials),
 *                         FloorCodeService.assignCodeTx (POST /v1/floor/codes), VendorService.createVendorRmMapping
 *   suppliers             VendorService.createVendorDetails        (POST /v1/vendors)
 *   supplier-lots         GrnService.createGrn                     (POST /v1/grns): lots are born in quarantine
 *   dilutions             DilutionService.createDilution           (POST /v1/material-dilutions)
 *   raw-stock-opening     BatchService.createRmBatch               (POST /v1/rm-batches): born in quarantine
 *   raw-stock-adjustment  StockService.createStockAdjustment       (POST /v1/stock-adjustments): a ledger row
 *   packaging-materials   CatalogService.createPackagingMaterial   (POST /v1/packaging-materials)
 *
 * So a row in a sheet and a form typed by hand are written by one function and cannot differ.
 */
import type { Sql, TransactionSql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  asPool, cellDate, cellQuantity, cellSigned, decimalText,
  type AuthPrincipal, type ImportContext, type ImportKindHandler, type ImportRowPlan, type ImportTableRow,
} from '@core/backend-kernel';
import { convertQty, netQty, signOf } from '@core/data-kernel';
import { DilutionService, judgeShares, masterdataSchema, materialNameKey, microText } from '@ra/cluster-masterdata';
import { VendorService, procurementSchema } from '@ra/cluster-procurement';
import { BatchService, GrnService, StockService, inventorySchema } from '@ra/cluster-inventory';
import { CatalogService, packagingSchema } from '@ra/cluster-packaging';
import type { MaterialChecked, MaterialImportService } from '../floor/material-import.service.js';
import { DILUTIONS, INGREDIENTS, PACKAGING_MATERIALS, RAW_STOCK_ADJUSTMENT, RAW_STOCK_OPENING, SUPPLIERS, SUPPLIER_LOTS } from './kind-specs.js';

/* ── small tools ──────────────────────────────────────────────────────────────────────────── */

/** A service's fragment ("the name is missing") as a sentence a person reads in a table. */
export const sentence = (s: string) => { const t = s.trim(); const c = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?]$/.test(c) ? c : `${c}.`; };
const plan = <I>(r: ImportTableRow, naturalKey: string, label: string): ImportRowPlan<I> =>
  ({ row: r.row, outcome: 'create', naturalKey, label, problems: [], notes: [], input: null, cells: r.cells });
const bound = <S>(Service: new (db: never) => S, tx: TransactionSql, pool: Sql, schema: Record<string, unknown>): S =>
  new Service(drizzle(asPool(tx, pool), { schema }) as never);
const up = (s: string) => s.trim().toUpperCase();
const low = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const need = (r: ImportTableRow, p: { problems: string[] }, key: string, header: string): string => {
  const v = (r.values[key] ?? '').trim();
  if (!v) p.problems.push(`"${header}" is empty.`);
  return v;
};

interface Mat { id: string; code: string; name: string; uom: string | null }
async function materialsByCode(sql: Sql, codes: string[]): Promise<Map<string, Mat>> {
  const want = [...new Set(codes.filter(Boolean).map(up))];
  if (!want.length) return new Map();
  const rows = await sql<{ id: string; code: string; name: string; uom: string | null }[]>`
    select m.material_id::text as id, m.material_code as code, m.material_name as name, u.uom_code as uom
      from masterdata.material m left join platform.uom_master u on u.uom_id = m.uom_id
     where upper(m.material_code) = any(${want})`;
  return new Map(rows.map((m) => [up(m.code), m]));
}
async function uomsByCode(sql: Sql): Promise<Map<string, { id: string; code: string }>> {
  const rows = await sql<{ id: string; code: string }[]>`select uom_id::text as id, uom_code as code from platform.uom_master where uom_code is not null`;
  return new Map(rows.map((u) => [u.code.trim().toLowerCase(), u]));
}
interface Vendor { id: string; code: string | null; name: string | null }
async function allVendors(sql: Sql): Promise<Vendor[]> {
  return sql<Vendor[]>`select vendor_id::text as id, vendor_code as code, vendor_name as name from procurement.vendor_details`;
}
function findVendor(vendors: Vendor[], text: string): Vendor | string {
  const want = low(text);
  const hits = vendors.filter((v) => low(v.code ?? '') === want || low(v.name ?? '') === want);
  if (hits.length === 1) return hits[0]!;
  return hits.length === 0 ? `No supplier "${text}" is on file. Add the supplier first.` : `"${text}" matches ${hits.length} suppliers. Use the supplier code.`;
}

/* GSTIN: 2 digits of state, 10 of PAN, an entity character, "Z", and a check character worked out
   over the first 14 in base 36 (CBIC registration rules). */
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinValid(text: string): boolean {
  const g = text.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = B36.indexOf(g[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return B36[(36 - (sum % 36)) % 36] === g[14];
}

/* ── ingredients ──────────────────────────────────────────────────────────────────────────── */

function ingredients(materialImport: MaterialImportService): ImportKindHandler<MaterialChecked> {
  return {
    spec: INGREDIENTS,
    async plan(rows) {
      const v = (r: ImportTableRow, k: string) => (r.values[k] ?? '').trim() || null;
      const checked = await materialImport.check(rows.map((r) => ({
        line: r.row, materialName: (r.values.name ?? '').trim(), materialCode: v(r, 'code'), family: v(r, 'family'), casNumber: v(r, 'cas'),
        hazardClass: v(r, 'hazardClass'), hazardSource: v(r, 'hazardSource'), unit: v(r, 'unit'), supplier: v(r, 'supplier'),
        density: v(r, 'density'), densitySource: v(r, 'densitySource'),
      })));
      return rows.map((r, i) => {
        const c = checked[i]!;
        const p = plan<MaterialChecked>(r, c.materialCode ?? materialNameKey(c.materialName), c.materialName);
        if (c.alreadyOnFile) {
          p.outcome = 'skip';
          p.problems.push(`Already on file as ${c.existing?.materialCode ?? 'a material with no code'}. Nothing on it is changed.`);
          return p;
        }
        p.problems.push(...c.errors.map(sentence));
        if (!c.hazardClass && c.hazardSource) p.problems.push('A hazard source is given with no hazard class. Give the class as it is printed, or clear the source.');
        p.notes.push(...c.warnings.map(sentence));
        if (!c.materialCode && !p.problems.length) p.notes.push('The next RM- code is given when it is imported.');
        return { ...p, input: c };
      });
    },
    async writeUnit(tx, rows, ctx) {
      for (const r of rows) await materialImport.writeRow(tx, r.input!, ctx.principal);
    },
  };
}

/* ── suppliers ────────────────────────────────────────────────────────────────────────────── */

interface SupplierInput { vendorCode: string | null; vendorName: string; gstin: string | null; panNumber: string | null; paymentTerms: string | null; contactEmail: string | null; contactPhone: string | null }

function suppliers(sql: Sql): ImportKindHandler<SupplierInput> {
  return {
    spec: SUPPLIERS,
    async plan(rows) {
      const vendors = await allVendors(sql);
      const byCode = new Map(vendors.filter((v) => v.code).map((v) => [up(v.code!), v]));
      const byName = new Map(vendors.filter((v) => v.name).map((v) => [low(v.name!), v]));
      const seenCode = new Map<string, number>(), seenName = new Map<string, number>();
      return rows.map((r) => {
        const code = (r.values.code ?? '').trim(), name = (r.values.name ?? '').trim();
        const p = plan<SupplierInput>(r, code || low(name), name);
        if (!name) p.problems.push('"Name" is empty.');
        if (name.length > 200) p.problems.push('The name is longer than 200 characters.');
        if (code.length > 50) p.problems.push('The supplier code is longer than 50 characters.');
        const gstin = up(r.values.gstin ?? ''), pan = up(r.values.pan ?? ''), email = (r.values.email ?? '').trim(), phone = (r.values.phone ?? '').trim();
        if (gstin && !gstinValid(gstin)) p.problems.push(`"${r.values.gstin}" is not a GSTIN: it is 15 characters and its last one is a check character that does not match.`);
        if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) p.problems.push(`"${r.values.pan}" is not a PAN (five letters, four digits, a letter).`);
        if (gstin && pan && gstinValid(gstin) && gstin.slice(2, 12) !== pan) p.problems.push('The PAN is not the one inside the GSTIN (its characters 3 to 12).');
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) p.problems.push(`"${email}" is not an email address.`);
        if (phone && !/^\+?[0-9][0-9 ()-]{6,19}$/.test(phone)) p.problems.push(`"${phone}" is not a phone number.`);
        if (code) { const d = seenCode.get(up(code)); if (d) p.problems.push(`The code ${code} is also on row ${d}.`); else seenCode.set(up(code), r.row); }
        if (name) { const d = seenName.get(low(name)); if (d) p.problems.push(`The same supplier name is on row ${d}.`); else seenName.set(low(name), r.row); }
        const codeHit = code ? byCode.get(up(code)) : undefined, nameHit = name ? byName.get(low(name)) : undefined;
        if (codeHit && low(codeHit.name ?? '') !== low(name)) p.problems.push(`The code ${code} belongs to another supplier on file.`);
        else if (codeHit || (nameHit && (!code || up(nameHit.code ?? '') === up(code)))) {
          if (!p.problems.length) { p.outcome = 'skip'; p.problems.push(`Already on file as ${(codeHit ?? nameHit)!.code ?? 'a supplier with no code'}. Nothing on it is changed.`); return p; }
        } else if (nameHit) p.problems.push(`A supplier of this name is already on file as ${nameHit.code ?? 'a supplier with no code'}.`);
        return { ...p, input: { vendorCode: code || null, vendorName: name, gstin: gstin || null, panNumber: pan || null, paymentTerms: (r.values.paymentTerms ?? '').trim() || null, contactEmail: email || null, contactPhone: phone || null } };
      });
    },
    async writeUnit(tx, rows, ctx) {
      for (const r of rows) await bound(VendorService, tx, sql, procurementSchema).createVendorDetails(r.input!, ctx.principal);
    },
  };
}

/* ── supplier lots (goods receipts) ───────────────────────────────────────────────────────── */

interface LotInput { materialId: string; vendorId: string; supplierLot: string; qty: string; uomId: string; receivedDate: string; mfgDate: string | null; expiryDate: string | null; certificate: string | null }

/** Quantity, unit and the ingredient's own unit: the quantity as text and the unit's id, or problems. */
function quantityIn(r: ImportTableRow, p: { problems: string[] }, uoms: Map<string, { id: string; code: string }>, mat: Mat | undefined): { qty: string; uomId: string } | null {
  const q = cellQuantity(r.values.quantity ?? '', 'Quantity');
  const unitText = (r.values.unit ?? '').trim();
  if (!q.ok) p.problems.push(q.problem); else if (!q.value) p.problems.push('"Quantity" is empty.');
  if (!unitText) p.problems.push('"Unit" is empty: a quantity needs its unit.');
  const uom = unitText ? uoms.get(unitText.toLowerCase()) : undefined;
  if (unitText && !uom) p.problems.push(`The unit "${unitText}" is not in the unit list (Setup, Units).`);
  if (!q.ok || !q.value || !uom) return null;
  const qty = decimalText(q.value);
  if (mat?.uom) {
    const c = convertQty(qty, uom.code, mat.uom);
    if ('refused' in c) { p.problems.push(`${mat.code} is kept in ${mat.uom}. ${sentence(c.refused)}`); return null; }
  }
  return { qty, uomId: uom.id };
}
function dates(r: ImportTableRow, p: { problems: string[] }, received: string | null, today: string): { mfg: string | null; expiry: string | null } {
  const m = cellDate(r.values.mfgDate ?? '', 'Manufacture date'), e = cellDate(r.values.expiryDate ?? '', 'Expiry date');
  if (!m.ok) p.problems.push(m.problem);
  if (!e.ok) p.problems.push(e.problem);
  const mfg = m.ok ? m.value : null, expiry = e.ok ? e.value : null;
  const ref = received ?? today;
  if (mfg && mfg > ref) p.problems.push(received ? 'The manufacture date is after the day it was received.' : 'The manufacture date is in the future.');
  if (expiry && received && expiry < received) p.problems.push('The expiry date is before the day it was received: expired stock is not received through a sheet.');
  if (expiry && mfg && expiry <= mfg) p.problems.push('The expiry date is not after the manufacture date.');
  return { mfg, expiry };
}

function supplierLots(sql: Sql): ImportKindHandler<LotInput> {
  return {
    spec: SUPPLIER_LOTS,
    async plan(rows, ctx) {
      const mats = await materialsByCode(sql, rows.map((r) => r.values.ingredient ?? ''));
      const vendors = await allVendors(sql);
      const uoms = await uomsByCode(sql);
      const matIds = [...mats.values()].map((m) => m.id);
      const onFile = matIds.length ? await sql<{ m: string; v: string | null; lot: string; batch: string }[]>`
        select b.material_id::text as m, g.vendor_id::text as v, lower(btrim(b.supplier_lot_ref)) as lot, b.batch_number as batch
          from inventory.rm_batch_master b
          join inventory.grn_items i on i.grn_item_id = b.grn_item_id
          join inventory.grn_master g on g.grn_id = i.grn_id
         where b.supplier_lot_ref is not null and b.material_id = any(${matIds}::uuid[])` : [];
      const received = new Map(onFile.map((x) => [`${x.m}|${x.v}|${x.lot}`, x.batch]));
      const seen = new Map<string, number>();
      return rows.map((r) => {
        const code = (r.values.ingredient ?? '').trim(), supplierText = (r.values.supplier ?? '').trim(), lot = (r.values.supplierLot ?? '').trim();
        const p = plan<LotInput>(r, `${up(code)} / ${supplierText} / ${lot}`, `${code} lot ${lot}`);
        need(r, p, 'ingredient', 'Ingredient code'); need(r, p, 'supplier', 'Supplier'); need(r, p, 'supplierLot', 'Supplier lot');
        if (lot.length > 100) p.problems.push('The supplier lot is longer than 100 characters.');
        const mat = code ? mats.get(up(code)) : undefined;
        if (code && !mat) p.problems.push(`No ingredient with the code ${code} is on file.`);
        const vendor = supplierText ? findVendor(vendors, supplierText) : null;
        if (typeof vendor === 'string') p.problems.push(vendor);
        const q = quantityIn(r, p, uoms, mat);
        const rec = cellDate(r.values.receivedDate ?? '', 'Received date');
        if (!rec.ok) p.problems.push(rec.problem); else if (!rec.value) p.problems.push('"Received date" is empty.');
        const receivedDate = rec.ok ? rec.value : null;
        if (receivedDate && receivedDate > ctx.today) p.problems.push('The received date is in the future.');
        const d = dates(r, p, receivedDate, ctx.today);
        const certificate = (r.values.certificate ?? '').trim();
        if (certificate.length > 100) p.problems.push('The certificate reference is longer than 100 characters.');
        if (mat && vendor && typeof vendor !== 'string' && lot) {
          const key = `${mat.id}|${vendor.id}|${lot.toLowerCase()}`;
          const first = seen.get(key);
          if (first) p.problems.push(`The same ingredient, supplier and lot is on row ${first}. One lot, one row: add the quantities.`); else seen.set(key, r.row);
          const batch = received.get(key);
          if (batch && !p.problems.length) { p.outcome = 'skip'; p.problems.push(`Already received as lot ${batch}.`); return p; }
          if (batch) p.problems.push(`This supplier lot was already received as lot ${batch}.`);
        }
        if (p.problems.length || !mat || !vendor || typeof vendor === 'string' || !q || !receivedDate) return p;
        p.notes.push('Lands in quarantine. QC releases it.');
        return { ...p, input: { materialId: mat.id, vendorId: vendor.id, supplierLot: lot, qty: q.qty, uomId: q.uomId, receivedDate, mfgDate: d.mfg, expiryDate: d.expiry, certificate: certificate || null } };
      });
    },
    // One supplier on one day is one goods receipt with a line for each row, as it is by hand.
    units(rows) {
      const groups = new Map<string, ImportRowPlan<LotInput>[]>();
      for (const r of rows) { const k = `${r.input!.vendorId}|${r.input!.receivedDate}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
      return [...groups.values()];
    },
    async writeUnit(tx, rows, ctx) {
      const first = rows[0]!.input!;
      await bound(GrnService, tx, sql, inventorySchema).createGrn({
        vendorId: first.vendorId, grnDate: first.receivedDate,
        items: rows.map((r) => ({
          materialId: r.input!.materialId, receivedQty: Number(r.input!.qty), uomId: r.input!.uomId,
          manufacturingDate: r.input!.mfgDate, expiryDate: r.input!.expiryDate,
          supplierLotRef: r.input!.supplierLot, certificateRef: r.input!.certificate, containers: [],
        })),
      } as never, ctx.principal);
    },
  };
}

/* ── dilutions ────────────────────────────────────────────────────────────────────────────── */

interface DilutionInput { dilutionMaterialId: string; baseMaterialId: string; solventMaterialId: string; basePercent: string; solventPercent: string }

function dilutions(sql: Sql): ImportKindHandler<DilutionInput> {
  return {
    spec: DILUTIONS,
    async plan(rows) {
      const mats = await materialsByCode(sql, rows.flatMap((r) => [r.values.dilution ?? '', r.values.base ?? '', r.values.solvent ?? '']));
      const ids = [...mats.values()].map((m) => m.id);
      const onFile = ids.length ? await sql<{ d: string; b: string; s: string; bp: string; bc: string | null; sc: string | null }[]>`
        select x.dilution_material_id::text as d, x.base_material_id::text as b, x.solvent_material_id::text as s, x.base_percent::text as bp,
               bm.material_code as bc, sm.material_code as sc
          from masterdata.material_dilution x
          join masterdata.material bm on bm.material_id = x.base_material_id
          join masterdata.material sm on sm.material_id = x.solvent_material_id
         where x.dilution_material_id = any(${ids}::uuid[])` : [];
      const have = new Map(onFile.map((x) => [x.d, x]));
      const seen = new Map<string, number>();
      return rows.map((r) => {
        const dCode = (r.values.dilution ?? '').trim();
        const p = plan<DilutionInput>(r, up(dCode), dCode);
        need(r, p, 'dilution', 'Dilution code');
        const bCode = need(r, p, 'base', 'Base ingredient'), sCode = need(r, p, 'solvent', 'Solvent');
        const d = mats.get(up(dCode)), b = mats.get(up(bCode)), s = mats.get(up(sCode));
        if (dCode && !d) p.problems.push(`No ingredient with the code ${dCode} is on file. A dilution is an ingredient of its own: add it first.`);
        if (bCode && !b) p.problems.push(`The base ${bCode} is not an ingredient on file.`);
        if (sCode && !s) p.problems.push(`The solvent ${sCode} is not an ingredient on file.`);
        if (b && s && b.id === s.id) p.problems.push('The base and the solvent are the same ingredient.');
        if (d && ((b && d.id === b.id) || (s && d.id === s.id))) p.problems.push('A dilution cannot be its own base or its own solvent.');
        const shares = judgeShares(r.values.basePercent ?? '', r.values.solventPercent ?? '');
        if ('problems' in shares) p.problems.push(...shares.problems.map(sentence));
        if (dCode) { const first = seen.get(up(dCode)); if (first) p.problems.push(`The dilution ${dCode} is also on row ${first}.`); else seen.set(up(dCode), r.row); }
        const on = d ? have.get(d.id) : undefined;
        if (on && b && s && 'shares' in shares) {
          const same = on.b === b.id && on.s === s.id && Number(on.bp) * 1_000_000 === shares.shares.baseMicro;
          if (same && !p.problems.length) { p.outcome = 'skip'; p.problems.push('Already on file with this base, solvent and shares.'); return p; }
          if (!same) p.problems.push(`${dCode} is already on file as ${Number(on.bp)}% ${on.bc ?? 'its base'} in ${on.sc ?? 'its solvent'}. A different ratio is a different material: give it its own code.`);
        }
        if (p.problems.length || !d || !b || !s || !('shares' in shares)) return p;
        return { ...p, input: { dilutionMaterialId: d.id, baseMaterialId: b.id, solventMaterialId: s.id, basePercent: microText(shares.shares.baseMicro), solventPercent: microText(shares.shares.solventMicro) } };
      });
    },
    async writeUnit(tx, rows, ctx) {
      for (const r of rows) await bound(DilutionService, tx, sql, masterdataSchema).createDilution(r.input!, ctx.principal);
    },
  };
}

/* ── opening raw stock ────────────────────────────────────────────────────────────────────── */

interface OpeningInput { materialId: string; lot: string; qty: string; uomId: string; storageLocationId: string | null; supplierLot: string | null; mfgDate: string | null; expiryDate: string | null }

function rawStockOpening(sql: Sql): ImportKindHandler<OpeningInput> {
  return {
    spec: RAW_STOCK_OPENING,
    async plan(rows, ctx) {
      const mats = await materialsByCode(sql, rows.map((r) => r.values.ingredient ?? ''));
      const uoms = await uomsByCode(sql);
      const lots = [...new Set(rows.map((r) => up(r.values.lot ?? '')).filter(Boolean))];
      const onFile = lots.length ? await sql<{ lot: string; m: string | null }[]>`select upper(batch_number) as lot, material_id::text as m from inventory.rm_batch_master where upper(batch_number) = any(${lots})` : [];
      const have = new Map(onFile.map((x) => [x.lot, x.m]));
      const locCodes = [...new Set(rows.map((r) => up(r.values.location ?? '')).filter(Boolean))];
      const locs = new Map(locCodes.length ? (await sql<{ id: string; code: string }[]>`select storage_location_id::text as id, upper(storage_location_code) as code from location.storage_location_master where upper(storage_location_code) = any(${locCodes})`).map((l) => [l.code, l.id]) : []);
      const seen = new Map<string, number>();
      return rows.map((r) => {
        const code = (r.values.ingredient ?? '').trim(), lot = (r.values.lot ?? '').trim();
        const p = plan<OpeningInput>(r, up(lot), `${code} lot ${lot}`);
        need(r, p, 'ingredient', 'Ingredient code'); need(r, p, 'lot', 'Lot');
        const reason = need(r, p, 'reason', 'Reason');
        if (lot.length > 50) p.problems.push('The lot number is longer than 50 characters.');
        const mat = code ? mats.get(up(code)) : undefined;
        if (code && !mat) p.problems.push(`No ingredient with the code ${code} is on file.`);
        const q = quantityIn(r, p, uoms, mat);
        const d = dates(r, p, null, ctx.today);
        const locText = (r.values.location ?? '').trim();
        const loc = locText ? locs.get(up(locText)) : undefined;
        if (locText && !loc) p.problems.push(`No storage location with the code ${locText} is on file.`);
        const supplierLot = (r.values.supplierLot ?? '').trim();
        if (supplierLot.length > 100) p.problems.push('The supplier lot is longer than 100 characters.');
        if (lot) { const first = seen.get(up(lot)); if (first) p.problems.push(`The lot ${lot} is also on row ${first}.`); else seen.set(up(lot), r.row); }
        if (lot && have.has(up(lot))) {
          if (mat && have.get(up(lot)) === mat.id && !p.problems.length) { p.outcome = 'skip'; p.problems.push('This lot is already on file for this ingredient.'); return p; }
          if (!mat || have.get(up(lot)) !== mat.id) p.problems.push(`The lot number ${lot} is already used for another ingredient.`);
          else p.problems.push('This lot is already on file for this ingredient.');
        }
        if (p.problems.length || !mat || !q) return p;
        // The single-record route keeps no reason on the lot; it is kept here, on the import's own row.
        p.notes.push(`Reason: ${reason}`, 'Lands in quarantine. QC releases it.');
        return { ...p, input: { materialId: mat.id, lot, qty: q.qty, uomId: q.uomId, storageLocationId: loc ?? null, supplierLot: supplierLot || null, mfgDate: d.mfg, expiryDate: d.expiry } };
      });
    },
    async writeUnit(tx, rows, ctx) {
      for (const r of rows) {
        const i = r.input!;
        await bound(BatchService, tx, sql, inventorySchema).createRmBatch({
          materialId: i.materialId, batchNumber: i.lot, receivedQty: Number(i.qty), uomId: i.uomId, storageLocationId: i.storageLocationId,
          supplierLotRef: i.supplierLot, manufacturingDate: i.mfgDate, expiryDate: i.expiryDate,
        } as never, ctx.principal);
      }
    },
  };
}

/* ── raw stock adjustments ────────────────────────────────────────────────────────────────── */

interface AdjustInput { inventoryBatchId: string; uomId: string | null; qty: string; reason: string }
const refTag = (reference: string) => `[ref ${reference.trim()}]`;

function rawStockAdjustment(sql: Sql): ImportKindHandler<AdjustInput> {
  return {
    spec: RAW_STOCK_ADJUSTMENT,
    async plan(rows) {
      const mats = await materialsByCode(sql, rows.map((r) => r.values.ingredient ?? ''));
      const lots = [...new Set(rows.map((r) => up(r.values.lot ?? '')).filter(Boolean))];
      const rm = lots.length ? await sql<{ lot: string; m: string | null }[]>`select upper(batch_number) as lot, material_id::text as m from inventory.rm_batch_master where upper(batch_number) = any(${lots})` : [];
      const rmByLot = new Map(rm.map((x) => [x.lot, x.m]));
      const live = lots.length ? await sql<{ id: string; lot: string; m: string | null; on_hand: string | null; uom: string | null; uom_id: string | null; loc: string | null }[]>`
        select ib.inventory_batch_id::text as id, upper(b.batch_number) as lot, b.material_id::text as m, ib.quantity_on_hand::text as on_hand,
               u.uom_code as uom, ib.uom_id::text as uom_id, upper(sl.storage_location_code) as loc
          from inventory.rm_batch_master b
          join inventory.inventory_batch ib on ib.rm_batch_id = b.rm_batch_id
          left join platform.uom_master u on u.uom_id = ib.uom_id
          left join location.storage_location_master sl on sl.storage_location_id = ib.storage_location_id
         where upper(b.batch_number) = any(${lots})` : [];
      const ids = live.map((x) => x.id);
      const held = ids.length ? await sql<{ id: string; uom: string | null; qty: string }[]>`
        select r.inventory_batch_id::text as id, u.uom_code as uom, sum(r.reserved_qty)::text as qty
          from inventory.stock_reservation r left join platform.uom_master u on u.uom_id = r.uom_id
         where r.inventory_batch_id = any(${ids}::uuid[]) and r.released_dt is null group by 1, 2` : [];
      const posted = ids.length ? await sql<{ id: string; reason: string | null }[]>`select inventory_batch_id::text as id, adjustment_reason as reason from inventory.stock_adjustment where inventory_batch_id = any(${ids}::uuid[])` : [];
      const running = new Map(live.map((x) => [x.id, x.on_hand ?? '0']));
      const seen = new Map<string, number>();
      return rows.map((r) => {
        const code = (r.values.ingredient ?? '').trim(), lot = (r.values.lot ?? '').trim();
        const p = plan<AdjustInput>(r, `${up(lot)} / ${(r.values.reference ?? '').trim()}`, `${code} lot ${lot}`);
        need(r, p, 'ingredient', 'Ingredient code'); need(r, p, 'lot', 'Lot');
        const reason = need(r, p, 'reason', 'Reason'), reference = need(r, p, 'reference', 'Reference');
        const ch = cellSigned(r.values.change ?? '', 'Change');
        if (!ch.ok) p.problems.push(ch.problem); else if (!ch.value) p.problems.push('"Change" is empty.');
        const unit = (r.values.unit ?? '').trim();
        if (!unit) p.problems.push('"Unit" is empty: a change needs its unit.');
        const mat = code ? mats.get(up(code)) : undefined;
        if (code && !mat) p.problems.push(`No ingredient with the code ${code} is on file.`);
        if (lot && !rmByLot.has(up(lot))) p.problems.push(`No lot ${lot} is on file.`);
        else if (lot && mat && rmByLot.get(up(lot)) !== mat.id) p.problems.push(`The lot ${lot} is not a lot of ${mat.code}.`);
        const locText = up(r.values.location ?? '');
        let places = live.filter((x) => x.lot === up(lot));
        if (lot && rmByLot.has(up(lot)) && places.length === 0) p.problems.push(`The lot ${lot} is not released to stock yet (it is held for QC), so it has no stock figure to adjust.`);
        if (locText) { places = places.filter((x) => x.loc === locText); if (lot && rmByLot.has(up(lot)) && live.some((x) => x.lot === up(lot)) && places.length === 0) p.problems.push(`The lot ${lot} is not at the location ${r.values.location}.`); }
        else if (places.length > 1) p.problems.push(`The lot ${lot} sits in ${places.length} places. Give the location of the one to adjust.`);
        const at = places.length === 1 ? places[0]! : undefined;
        if (at && reference) {
          const key = `${at.id}|${reference.toLowerCase()}`;
          const first = seen.get(key);
          if (first) p.problems.push(`The same lot and reference is on row ${first}.`); else seen.set(key, r.row);
          if (posted.some((x) => x.id === at.id && (x.reason ?? '').toLowerCase().endsWith(refTag(reference).toLowerCase()))) {
            if (!p.problems.length) { p.outcome = 'skip'; p.problems.push(`A change for this lot under the reference ${reference} is already posted.`); return p; }
          }
        }
        if (p.problems.length || !at || !ch.ok || !ch.value) return p;
        const magnitude = decimalText({ ...ch.value, negative: false });
        const c = convertQty(magnitude, unit, at.uom);
        if ('refused' in c) { p.problems.push(at.uom ? `The lot is kept in ${at.uom}. ${sentence(c.refused)}` : 'The lot has no unit on file, so a change in a unit cannot be applied to it.'); return p; }
        const before = running.get(at.id) ?? '0';
        const change = [{ qty: c.qty, uom: at.uom }];
        const after = ch.value.negative ? netQty([{ qty: before, uom: at.uom }], change, at.uom) : netQty([{ qty: before, uom: at.uom }, ...change], [], at.uom);
        if ('refused' in after) { p.problems.push(sentence(after.refused)); return p; }
        // The single-record service's own refusal, in its words (StockService.createStockAdjustment).
        if (signOf(after.qty) < 0) { p.problems.push(`Adjustment would take on-hand negative (${after.qty}). The lot holds ${before} ${at.uom ?? ''}.`.replace(/\s+\./, '.')); return p; }
        if (ch.value.negative) {
          const mine = held.filter((h) => h.id === at.id).map((h) => ({ qty: h.qty, uom: h.uom ?? at.uom }));
          const free = netQty([{ qty: after.qty, uom: at.uom }], mine, at.uom);
          if ('refused' in free) { p.problems.push(sentence(free.refused)); return p; }
          if (mine.length && signOf(free.qty) < 0) {
            const reserved = netQty(mine, [], at.uom);
            p.problems.push(`${'qty' in reserved ? reserved.qty : 'Part'} ${at.uom ?? ''} of this lot is reserved for production, and this decrease would leave ${after.qty}: it cuts into the reservation (on-hand − active reservations). Release the reservation first, or adjust the lot on its own screen.`.replace(/\s{2,}/g, ' '));
            return p;
          }
        }
        running.set(at.id, after.qty);
        return { ...p, input: { inventoryBatchId: at.id, uomId: at.uom_id, qty: `${ch.value.negative ? '-' : ''}${c.qty}`, reason: `${reason} ${refTag(reference)}` } };
      });
    },
    async writeUnit(tx, rows, ctx) {
      for (const r of rows) {
        const i = r.input!;
        await bound(StockService, tx, sql, inventorySchema).createStockAdjustment({ inventoryBatchId: i.inventoryBatchId, adjustmentQty: Number(i.qty), uomId: i.uomId, adjustmentReason: i.reason } as never, ctx.principal);
      }
    },
  };
}

/* ── packaging materials ──────────────────────────────────────────────────────────────────── */

interface PackagingInput { packagingMaterialCode: string; packagingMaterialName: string; uomId?: string }

function packagingMaterials(sql: Sql): ImportKindHandler<PackagingInput> {
  return {
    spec: PACKAGING_MATERIALS,
    async plan(rows) {
      const uoms = await uomsByCode(sql);
      const codes = [...new Set(rows.map((r) => up(r.values.code ?? '')).filter(Boolean))];
      const onFile = new Map(codes.length ? (await sql<{ code: string; name: string | null }[]>`select upper(packaging_material_code) as code, packaging_material_name as name from packaging.packaging_material_master where upper(packaging_material_code) = any(${codes})`).map((x) => [x.code, x.name]) : []);
      const seen = new Map<string, number>();
      return rows.map((r) => {
        const p = plan<PackagingInput>(r, up(r.values.code ?? ''), (r.values.name ?? '').trim());
        const code = need(r, p, 'code', 'Code'), name = need(r, p, 'name', 'Name');
        if (code.length > 50) p.problems.push('The code is longer than 50 characters.');
        if (name.length > 200) p.problems.push('The name is longer than 200 characters.');
        const unit = (r.values.unit ?? '').trim();
        const uom = unit ? uoms.get(unit.toLowerCase()) : undefined;
        if (unit && !uom) p.problems.push(`The unit "${unit}" is not in the unit list (Setup, Units).`);
        if (code) { const first = seen.get(up(code)); if (first) p.problems.push(`The code ${code} is also on row ${first}.`); else seen.set(up(code), r.row); }
        if (code && onFile.has(up(code))) {
          if (low(onFile.get(up(code)) ?? '') === low(name) && !p.problems.length) { p.outcome = 'skip'; p.problems.push('Already on file under this code and name.'); return p; }
          if (low(onFile.get(up(code)) ?? '') !== low(name)) p.problems.push(`The code ${code} is on file under another name.`);
        }
        if (p.problems.length) return p;
        return { ...p, input: { packagingMaterialCode: code, packagingMaterialName: name, ...(uom ? { uomId: uom.id } : {}) } };
      });
    },
    async writeUnit(tx, rows, ctx) {
      for (const r of rows) await bound(CatalogService, tx, sql, packagingSchema).createPackagingMaterial(r.input!, ctx.principal);
    },
  };
}

export function factoryKinds(sql: Sql, materialImport: MaterialImportService): ImportKindHandler[] {
  return [ingredients(materialImport), suppliers(sql), supplierLots(sql), dilutions(sql), rawStockOpening(sql), rawStockAdjustment(sql), packagingMaterials(sql)] as ImportKindHandler[];
}

export type { AuthPrincipal, ImportContext };
