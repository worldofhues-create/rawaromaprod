/**
 * PurchasePriceService (IMPORT-RP-COST, LD-156) — what a material costs to buy, as a list that has a
 * history. Owner, 13 Nov 2026: "we just haven't yet uploaded purchase price purchase discount etc ...
 * keep an option in interface to export materials and add purchase price and update it finance
 * console receives it which is books".
 *
 * ONE FUNCTION, TWO DOORS. `judge` decides what a price row is (new, already on file, refused) and
 * `record` writes it; POST /v1/material-purchase-prices (one price, typed) and the
 * `material-purchase-prices` import kind (a sheet) both call them, so a typed price and a row in a
 * sheet cannot be judged or written differently.
 *
 * MONEY IS COMPUTED ONCE, HERE. Rupees typed by a person become integer paise once (cellRupees). The
 * net price is list less discount on the exact product, rounded once, half up to the paisa
 * (`netPaise`), and stored beside its two inputs. Nothing downstream recomputes it: the fact ALEMBIC
 * receives carries the same three integers the row holds.
 *
 * THE HISTORY IS APPEND-ONLY. A row is keyed by material, supplier and effective date. The same row
 * again changes nothing; a later date supersedes; a different figure for a date already on file is
 * refused, because a price somebody may already have costed a batch with is never rewritten. An
 * empty price cell is "no change", never zero.
 *
 * THE FACT. Each recorded row writes one `material.cost.recorded` row to bridge.outbox in the same
 * transaction (emitBridgeManualEvent), so it commits or rolls back with the price. Its row id is the
 * envelope's event id: the relay retries under that id and never mints another. The body is what a
 * purchase order already shows purchasing and finance: a material's code and name, a supplier, a
 * price. No person's name, no formula, no quantity of any formula line.
 */
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { asPool, cellDate, cellPercentBps, cellRupees, emitBridgeManualEvent, PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';

export const MATERIAL_COST_RECORDED = 'material.cost.recorded';
/** An effective date further ahead than this is refused: a price that far off is a typo in the year. */
export const MAX_DAYS_AHEAD = 90;
export const LARGE_CHANGE_KEY = 'large_change_pct';
export const LARGE_CHANGE_DEFAULT_PCT = 20;

/** The units a price may be per, as the fact names them. */
export type PriceUnit = 'kg' | 'g' | 'L' | 'ml' | 'unit';
const UNIT_OF: Record<string, PriceUnit> = {
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g',
  l: 'L', lt: 'L', ltr: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L', ml: 'ml', millilitre: 'ml', milliliter: 'ml',
  unit: 'unit', units: 'unit', pcs: 'unit', pc: 'unit', nos: 'unit', no: 'unit', ea: 'unit', each: 'unit', piece: 'unit', pieces: 'unit',
};
export const priceUnit = (code: string | null | undefined): PriceUnit | null => UNIT_OF[String(code ?? '').trim().toLowerCase()] ?? null;

/** List less discount, on the exact product, rounded ONCE, half up to the paisa. */
export function netPaise(listPaise: bigint, discountBps: number): bigint {
  return (listPaise * BigInt(10000 - discountBps) + 5000n) / 10000n;
}
export const rupees = (paise: bigint | number | string): string => {
  const p = BigInt(paise);
  return `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;
};
const bpsText = (bps: number) => `${Math.floor(bps / 100)}${bps % 100 ? `.${String(bps % 100).padStart(2, '0').replace(/0$/, '')}` : ''}`;
const addDays = (isoDay: string, days: number) => new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const low = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** One price as either door hands it over: every value is text, as a person gave it. */
export interface PriceInput {
  line: number;
  materialCode: string;
  unit: string;
  supplier: string;
  listPrice: string;
  discountPercent: string;
  gstRate: string;
  hsn: string;
  effectiveFrom: string;
  note: string;
}
/** What `record` writes. */
export interface PriceRecord {
  materialId: string; materialCode: string; materialName: string;
  vendorId: string | null; supplierCode: string | null; supplierName: string | null;
  unit: PriceUnit; listPaise: bigint; discountBps: number; netPaise: bigint;
  gstRatePct: string | null; hsnCode: string | null; effectiveFrom: string; note: string | null;
}
export interface PriceJudgement {
  line: number;
  outcome: 'create' | 'skip' | 'refuse';
  problems: string[];
  notes: string[];
  /** True when the net price moves by more than the limit against the price in force. Never blocks. */
  largeChange: boolean;
  key: string;
  label: string;
  record: PriceRecord | null;
}

interface OnFile { material_id: string; vendor_id: string | null; unit: string; list_price_paise: string; discount_bps: number; net_price_paise: string; gst_rate_pct: string | null; hsn_code: string | null; effective_from: string }

@Injectable()
export class PurchasePriceService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /* ── the settable limit ───────────────────────────────────────────────────────────────── */

  async largeChangePct(): Promise<number> {
    const [r] = await this.sql<{ v: string }[]>`select value_pct::text as v from procurement.purchase_price_setting where key = ${LARGE_CHANGE_KEY}`;
    return r ? Number(r.v) : LARGE_CHANGE_DEFAULT_PCT;
  }
  async setLargeChangePct(value: unknown, principal: AuthPrincipal): Promise<{ largeChangePct: number }> {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (!Number.isFinite(n) || n <= 0 || n > 1000 || Math.round(n * 100) !== n * 100) throw new BadRequestException('Give the limit as a percentage more than 0, with at most two decimals (20 means a change of more than 20% is listed).');
    await this.sql`insert into procurement.purchase_price_setting (key, value_pct, updated_by) values (${LARGE_CHANGE_KEY}, ${n}, ${principal.userId})
                   on conflict (key) do update set value_pct = excluded.value_pct, updated_by = excluded.updated_by, updated_dt = now()`;
    return { largeChangePct: n };
  }

  /* ── judging ──────────────────────────────────────────────────────────────────────────── */

  /** Every row judged against what is on file, and nothing written. */
  async judge(inputs: readonly PriceInput[], today: string): Promise<PriceJudgement[]> {
    const codes = [...new Set(inputs.map((i) => i.materialCode.trim().toUpperCase()).filter(Boolean))];
    const mats = new Map(codes.length ? (await this.sql<{ id: string; code: string; name: string | null; uom: string | null }[]>`
      select m.material_id::text as id, m.material_code as code, m.material_name as name, u.uom_code as uom
        from masterdata.material m left join platform.uom_master u on u.uom_id = m.uom_id
       where upper(m.material_code) = any(${codes})`).map((m) => [m.code.toUpperCase(), m]) : []);
    const vendors = inputs.some((i) => i.supplier.trim())
      ? await this.sql<{ id: string; code: string | null; name: string | null }[]>`select vendor_id::text as id, vendor_code as code, vendor_name as name from procurement.vendor_details`
      : [];
    const ids = [...mats.values()].map((m) => m.id);
    const onFile = ids.length ? await this.sql<OnFile[]>`
      select material_id::text as material_id, vendor_id::text as vendor_id, unit, list_price_paise::text as list_price_paise, discount_bps,
             net_price_paise::text as net_price_paise, gst_rate_pct::text as gst_rate_pct, hsn_code, effective_from::text as effective_from
        from procurement.material_purchase_price where material_id = any(${ids}::uuid[]) order by effective_from` : [];
    const limit = await this.largeChangePct();
    const seen = new Map<string, number>();

    return inputs.map((i) => {
      const code = i.materialCode.trim();
      const j: PriceJudgement = { line: i.line, outcome: 'create', problems: [], notes: [], largeChange: false, key: code.toUpperCase(), label: code, record: null };
      const refuse = (p: string) => { j.problems.push(p); };
      if (!code) refuse('"Material code" is empty.');
      const mat = code ? mats.get(code.toUpperCase()) : undefined;
      if (code && !mat) refuse(`No material with the code ${code} is on file.`);
      if (mat) j.label = `${mat.code} ${mat.name ?? ''}`.trim();

      const list = cellRupees(i.listPrice, 'List purchase price (Rs per unit)');
      if (!list.ok) refuse(list.problem);
      // An empty price cell is "no change", never zero: the row is passed over whatever else it holds.
      if (list.ok && list.value === null) {
        if (!j.problems.length) { j.outcome = 'skip'; j.problems.push('No price is given, so nothing changes for this material.'); return j; }
        return { ...j, outcome: 'refuse' };
      }
      if (list.ok && list.value === 0n) refuse('A purchase price of zero is not a price. Leave the cell empty for "no change".');

      let vendor: { id: string; code: string | null; name: string | null } | null = null;
      if (i.supplier.trim()) {
        const want = low(i.supplier);
        const hits = vendors.filter((v) => low(v.code ?? '') === want || low(v.name ?? '') === want);
        if (hits.length === 1) vendor = hits[0]!;
        else refuse(hits.length === 0 ? `No supplier "${i.supplier.trim()}" is on file. Add the supplier first, or leave the cell empty.` : `"${i.supplier.trim()}" matches ${hits.length} suppliers. Use the supplier code.`);
      }
      const unitText = i.unit.trim() || mat?.uom || '';
      const unit = priceUnit(unitText);
      if (!unitText) refuse('"Unit" is empty and the material has no unit on file: a price is a price per something.');
      else if (!unit) refuse(`A price cannot be per "${unitText}". Give it per kg, g, L, ml or unit.`);

      const disc = cellPercentBps(i.discountPercent, 'Purchase discount %');
      if (!disc.ok) refuse(disc.problem);
      const bps = disc.ok ? disc.value ?? 0 : 0;
      if (bps > 10000) refuse('A purchase discount of more than 100% is not a discount.');
      const gst = cellPercentBps(i.gstRate, 'GST rate %');
      if (!gst.ok) refuse(gst.problem); else if ((gst.value ?? 0) > 10000) refuse('A GST rate of more than 100% is not a rate.');
      const hsn = i.hsn.trim().replace(/\s+/g, '');
      if (hsn && !/^(\d{4}|\d{6}|\d{8})$/.test(hsn)) refuse(`"${i.hsn.trim()}" is not an HSN code (4, 6 or 8 digits).`);
      const eff = cellDate(i.effectiveFrom, 'Effective from');
      if (!eff.ok) refuse(eff.problem); else if (!eff.value) refuse('"Effective from" is empty: a price needs the day it starts.');
      else if (eff.value > addDays(today, MAX_DAYS_AHEAD)) refuse(`The effective date is more than ${MAX_DAYS_AHEAD} days ahead. Check the year.`);
      if (i.note.length > 500) refuse('The note is longer than 500 characters.');
      if (j.problems.length || !mat || !unit || !list.ok || !list.value || !eff.ok || !eff.value || !gst.ok) return { ...j, outcome: 'refuse' };

      const day = eff.value;
      const net = netPaise(list.value, bps);
      j.key = `${mat.code.toUpperCase()} / ${vendor?.code ?? vendor?.name ?? 'no supplier'} / ${day}`;
      const k = `${mat.id}|${vendor?.id ?? ''}|${day}`;
      const first = seen.get(k);
      if (first) { refuse(`The same material, supplier and effective date is on row ${first}.`); return { ...j, outcome: 'refuse' }; }
      seen.set(k, i.line);

      const history = onFile.filter((p) => p.material_id === mat.id && (p.vendor_id ?? '') === (vendor?.id ?? ''));
      const same = history.find((p) => p.effective_from.slice(0, 10) === day);
      const gstText = gst.value === null ? null : (gst.value / 100).toFixed(2);
      if (same) {
        const identical = BigInt(same.list_price_paise) === list.value && same.discount_bps === bps && same.unit === unit
          && (same.gst_rate_pct === null ? null : Number(same.gst_rate_pct).toFixed(2)) === gstText && (same.hsn_code ?? '') === hsn;
        if (identical) { j.outcome = 'skip'; j.problems.push('This price is already on file from this date.'); return j; }
        refuse(`A price from ${day} is already on file for this material and supplier (Rs ${rupees(same.list_price_paise)} per ${same.unit}, ${bpsText(same.discount_bps)}% discount). A price on file is never rewritten: give a later effective date.`);
        return { ...j, outcome: 'refuse' };
      }
      // Seen before committing, never asked about: a sheet cannot confirm.
      const inForce = [...history].reverse().find((p) => p.effective_from.slice(0, 10) < day);
      if (inForce && inForce.unit !== unit) j.notes.push(`The price in force is per ${inForce.unit} and this one is per ${unit}, so the two are not compared.`);
      else if (inForce && BigInt(inForce.net_price_paise) > 0n) {
        const was = BigInt(inForce.net_price_paise);
        const movedBps = Number(((net > was ? net - was : was - net) * 10000n) / was);
        if (movedBps > limit * 100) {
          j.largeChange = true;
          j.notes.push(`Large change: the net price goes ${net > was ? 'up' : 'down'} ${(movedBps / 100).toFixed(1)}% (Rs ${rupees(was)} to Rs ${rupees(net)} per ${unit}). The limit is ${limit}%. Check it before you import.`);
        }
      }
      const later = history.find((p) => p.effective_from.slice(0, 10) > day);
      if (later) j.notes.push(`A later price, from ${later.effective_from.slice(0, 10)}, is already on file: this row applies only until then.`);
      j.notes.push(`Net Rs ${rupees(net)} per ${unit}.`);
      j.record = { materialId: mat.id, materialCode: mat.code, materialName: mat.name ?? mat.code, vendorId: vendor?.id ?? null, supplierCode: vendor?.code ?? null, supplierName: vendor?.name ?? null,
        unit, listPaise: list.value, discountBps: bps, netPaise: net, gstRatePct: gstText, hsnCode: hsn || null, effectiveFrom: day, note: i.note.trim() || null };
      return j;
    });
  }

  /* ── writing ──────────────────────────────────────────────────────────────────────────── */

  /** One price row and its fact for ALEMBIC, inside the caller's transaction. */
  async record(tx: TransactionSql, r: PriceRecord, source: 'import' | 'screen', jobRef: string | null, principal: AuthPrincipal): Promise<{ materialPurchasePriceId: string }> {
    const id = uuidv7();
    await tx`insert into procurement.material_purchase_price
               (material_purchase_price_id, material_id, vendor_id, unit, list_price_paise, discount_bps, net_price_paise, gst_rate_pct, hsn_code, effective_from, note, source, job_ref, created_by)
             values (${id}, ${r.materialId}, ${r.vendorId}, ${r.unit}, ${r.listPaise.toString()}, ${r.discountBps}, ${r.netPaise.toString()}, ${r.gstRatePct}, ${r.hsnCode},
                     ${r.effectiveFrom}, ${r.note}, ${source}, ${jobRef}, ${principal.userId})`;
    await emitBridgeManualEvent(drizzle(asPool(tx, this.sql)), MATERIAL_COST_RECORDED, id, costFact(r, source, jobRef));
    return { materialPurchasePriceId: id };
  }

  /** POST /v1/material-purchase-prices: one price, typed on the material's screen. */
  async recordOne(body: Record<string, unknown>, principal: AuthPrincipal, today: string) {
    const text = (v: unknown) => (v == null ? '' : String(v));
    const [j] = await this.judge([{ line: 1, materialCode: text(body.materialCode), unit: text(body.unit), supplier: text(body.supplier ?? body.supplierCode), listPrice: text(body.listPrice),
      discountPercent: text(body.discountPercent), gstRate: text(body.gstRate), hsn: text(body.hsn ?? body.hsnCode), effectiveFrom: text(body.effectiveFrom), note: text(body.note) }], today);
    if (j!.outcome === 'skip' && String(body.listPrice ?? '').trim() === '') throw new BadRequestException('Give the list purchase price.');
    if (j!.outcome === 'skip') return { recorded: false, message: j!.problems.join(' '), notes: j!.notes };
    if (j!.outcome === 'refuse' || !j!.record) {
      const message = j!.problems.join(' ');
      throw /already on file/.test(message) ? new ConflictException(message) : new BadRequestException(message);
    }
    const made = await this.sql.begin((tx) => this.record(tx, j!.record!, 'screen', null, principal));
    return { recorded: true, ...made, netPrice: rupees(j!.record.netPaise), notes: j!.notes };
  }

  /* ── reading ──────────────────────────────────────────────────────────────────────────── */

  /** The price history, newest first, optionally for one material code. */
  async history(materialCode?: string, limit = 200) {
    const code = (materialCode ?? '').trim().toUpperCase() || null;
    const items = await this.sql`
      select p.material_purchase_price_id::text as "materialPurchasePriceId", m.material_code as "materialCode", m.material_name as "materialName",
             v.vendor_code as "supplierCode", v.vendor_name as "supplierName", p.unit,
             p.list_price_paise::text as "listPricePaise", p.discount_bps as "discountBps", p.net_price_paise::text as "netPricePaise",
             p.gst_rate_pct::float as "gstRatePct", p.hsn_code as "hsnCode", p.effective_from::text as "effectiveFrom", p.note, p.source, p.job_ref::text as "jobRef",
             p.created_by as "createdBy", p.created_dt as "createdDt"
        from procurement.material_purchase_price p
        join masterdata.material m on m.material_id = p.material_id
        left join procurement.vendor_details v on v.vendor_id = p.vendor_id
       where (${code}::text is null or upper(m.material_code) = ${code})
       order by p.effective_from desc, p.created_dt desc
       limit ${Math.min(Math.max(1, limit), 500)}`;
    return { items: items.map((r) => ({ ...(r as Record<string, unknown>), listPrice: rupees(r.listPricePaise as string), netPrice: rupees(r.netPricePaise as string), effectiveFrom: String(r.effectiveFrom).slice(0, 10) })), nextCursor: null };
  }

  /**
   * What is on file, as the sheet's own rows: every active material, with its unit, its preferred
   * supplier, and the price in force today for that supplier (or for no supplier) where there is one.
   * A material with no price comes out with empty price cells for the person to fill.
   */
  async exportRows(today: string): Promise<Record<string, string>[]> {
    const rows = await this.sql<{ code: string; name: string | null; uom: string | null; vendor_code: string | null; unit: string | null; list: string | null; bps: number | null; gst: string | null; hsn: string | null; eff: string | null; note: string | null }[]>`
      select m.material_code as code, m.material_name as name, u.uom_code as uom,
             coalesce(pv.vendor_code, dv.vendor_code) as vendor_code,
             p.unit, p.list_price_paise::text as list, p.discount_bps as bps, p.gst_rate_pct::text as gst, p.hsn_code as hsn, p.effective_from::text as eff, p.note
        from masterdata.material m
        left join platform.uom_master u on u.uom_id = m.uom_id
        left join lateral (select x.* from procurement.material_purchase_price x
                            where x.material_id = m.material_id and x.effective_from <= ${today}::date
                            order by x.effective_from desc, x.created_dt desc limit 1) p on true
        left join procurement.vendor_details pv on pv.vendor_id = p.vendor_id
        left join lateral (select v.vendor_code from procurement.vendor_rm_mapping vm join procurement.vendor_details v on v.vendor_id = vm.vendor_id
                            where vm.material_id = m.material_id and p.material_purchase_price_id is null
                            order by vm.is_preferred desc nulls last, vm.created_dt limit 1) dv on true
       where m.material_code is not null and coalesce(upper(m.status), 'ACTIVE') = 'ACTIVE'
       order by m.material_code`;
    return rows.map((r) => ({
      material: r.code, name: r.name ?? '', unit: r.unit ?? priceUnit(r.uom) ?? r.uom ?? '', supplier: r.vendor_code ?? '',
      listPrice: r.list ? rupees(r.list) : '', discount: r.list ? bpsText(r.bps ?? 0) : '', gst: r.gst ? String(Number(r.gst)) : '', hsn: r.hsn ?? '',
      effectiveFrom: r.eff ? `${r.eff.slice(8, 10)}/${r.eff.slice(5, 7)}/${r.eff.slice(0, 4)}` : '', note: r.note ?? '',
    }));
  }
}

/**
 * The body of `material.cost.recorded`, version 1 (LD-156). Field for field what the lead's contract
 * names. Money is the integers the row holds; nothing is recomputed here.
 */
export function costFact(r: PriceRecord, source: 'import' | 'screen', jobRef: string | null): Record<string, unknown> {
  return {
    material_code: r.materialCode,
    material_name: r.materialName,
    unit: r.unit,
    supplier_code: r.supplierCode,
    supplier_name: r.supplierName,
    list_price_paise_per_unit: Number(r.listPaise),
    purchase_discount_bps: r.discountBps,
    net_price_paise_per_unit: Number(r.netPaise),
    gst_rate_pct: r.gstRatePct === null ? null : Number(r.gstRatePct),
    hsn_code: r.hsnCode,
    effective_from: r.effectiveFrom,
    source,
    job_ref: jobRef,
  };
}
