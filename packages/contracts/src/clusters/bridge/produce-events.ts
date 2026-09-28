/**
 * Produce-to-order bridge contract, RawProd's side (owner requirement 2026-09-29, lane produce).
 * Pure: no I/O, no NestJS. Shared by the bridge importer (backend/api), the put-away flow that
 * emits `fg.batch.received`, the QC release that emits `qc.batch.released`, and the Vault
 * certificate sync, plus the tests that pin every shape.
 *
 * Three things live here:
 *
 *   1. The fields ALEMBIC (lane/fulfil) ADDS to ProductionRequirementCreated/Changed:
 *        priority    { rank: int, reason: 'high_value'|'fifo'|'promised_date', order_value_inr: number }
 *        needed_by   date
 *        order_refs  [string]
 *        sku, pack_size, qty_kg, lot_policy: 'fifo'
 *      ALEMBIC ranks (owner decision 2026-09-29: an order of ₹25,000 or more is high value);
 *      RawProd honours `priority.rank` / `priority.reason` and never re-ranks.
 *
 *   2. `fg.batch.received` — RawProd → ALEMBIC when a finished-good batch is put away on a rack,
 *      so ALEMBIC can allocate it to the orders waiting for it:
 *        { batch_no, sku, pack_size, qty_kg, rack, released_at }
 *
 *   3. The DOCS-001 wire shapes ALEMBIC parses for `qc.batch.released` and
 *      `compliance.certificate.calculated` (ALEMBIC docs/bridge/COMPLIANCE_FACTS.md, mirrored in
 *      docs/bridge/COMPLIANCE_FACTS.md here): snake_case, measurements as strings exactly as they
 *      print, `product_ref: { factory_sku }`, both QC verdicts. The lane/compliance-rp builders
 *      produce RawProd's internal camelCase record; `toQcBatchReleasedWire` /
 *      `toCertificateCalculatedWire` turn it into what actually crosses the bridge, and
 *      `checkQcBatchReleasedWire` / `checkCertificateCalculatedWire` apply ALEMBIC's own parse
 *      rules (packages/domain/src/compliance/documents.ts on that side) before anything is written
 *      to the outbox, so a payload ALEMBIC would refuse is refused here instead of parking there.
 *
 * NONE OF THESE MAY CARRY FORMULA CONTENT. Every emitter still runs `assertNoFormulaContent`.
 */
import type {
  AllergenCertificateValue,
  ComplianceCertificatePayload,
  IfraCertificateValue,
  QcBatchReleasedPayload,
} from "./compliance-events.js";

/* ── 1. requirement fields ─────────────────────────────────────────────────────────────────── */

/** Owner decision 2026-09-29: an order worth ₹25,000 or more is high value. ALEMBIC ranks with
 *  it; RawProd uses it only to count/alert on requirements whose sender did not label a reason. */
export const HIGH_VALUE_THRESHOLD_INR = 25_000;

export const REQUIREMENT_PRIORITY_REASONS = ["high_value", "fifo", "promised_date"] as const;
export type RequirementPriorityReason = (typeof REQUIREMENT_PRIORITY_REASONS)[number];

export const LOT_POLICIES = ["fifo"] as const;
export type LotPolicy = (typeof LOT_POLICIES)[number];

/** The legacy one-word priority the v1 contract carried (still accepted). */
export const LEGACY_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export interface RequirementPriority {
  readonly rank: number;
  readonly reason: RequirementPriorityReason;
  readonly order_value_inr: number;
}

/** True for `{ rank: int >= 0, reason: one of three, order_value_inr: finite number >= 0 }`. */
export function isRequirementPriority(v: unknown): v is RequirementPriority {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return typeof p.rank === "number" && Number.isInteger(p.rank) && p.rank >= 0 && p.rank <= 2_147_483_647
    && typeof p.reason === "string" && (REQUIREMENT_PRIORITY_REASONS as readonly string[]).includes(p.reason)
    && typeof p.order_value_inr === "number" && Number.isFinite(p.order_value_inr) && p.order_value_inr >= 0;
}

/** True when the requirement counts as high value: ALEMBIC said so, or the order value is at or
 *  over the owner's threshold. */
export function isHighValue(reason: string | null | undefined, orderValueInr: number | string | null | undefined): boolean {
  if (reason === "high_value") return true;
  const v = orderValueInr === null || orderValueInr === undefined || orderValueInr === "" ? NaN : Number(orderValueInr);
  return Number.isFinite(v) && v >= HIGH_VALUE_THRESHOLD_INR;
}

/* ── 2. fg.batch.received ──────────────────────────────────────────────────────────────────── */

export const FG_BATCH_RECEIVED = "fg.batch.received" as const;
/** Envelope `aggregate.type` for `fg.batch.received`; `aggregate.id` = RawProd's FG batch uuid. */
export const FG_BATCH_AGGREGATE_TYPE = "fg_batch" as const;

export interface FgBatchReceivedPayload {
  /** The FG batch number printed on the label (== the lot code ALEMBIC holds). */
  readonly batch_no: string;
  /** RawProd's factory SKU code (packaging.product_sku.sku_code) — ALEMBIC's `mapped_sku`. */
  readonly sku: string;
  /** The SKU's pack size as RawProd records it (e.g. "25 kg"), or null when none is set. */
  readonly pack_size: string | null;
  /** Quantity put away, in kilograms. */
  readonly qty_kg: number;
  /** The put-away location: rack code, then shelf and bin when the rack has them ("R01-S2-B3"). */
  readonly rack: string;
  /** When QC released the batch (ISO 8601 UTC) — FIFO age on ALEMBIC's side. */
  readonly released_at: string;
}

const isNonEmpty = (v: unknown, max = 200) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isIsoInstant = (v: unknown) => typeof v === "string" && v.includes("T") && !Number.isNaN(Date.parse(v));

/** Problems with an `fg.batch.received` payload ([] = valid). Exactly the six fields. */
export function validateFgBatchReceived(p: FgBatchReceivedPayload): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.batch_no, 64)) out.push("batch_no");
  if (!isNonEmpty(p.sku)) out.push("sku");
  if (!(p.pack_size === null || isNonEmpty(p.pack_size, 50))) out.push("pack_size");
  if (typeof p.qty_kg !== "number" || !Number.isFinite(p.qty_kg) || p.qty_kg <= 0) out.push("qty_kg");
  if (!isNonEmpty(p.rack, 120)) out.push("rack");
  if (!isIsoInstant(p.released_at)) out.push("released_at");
  const allowed = new Set(["batch_no", "sku", "pack_size", "qty_kg", "rack", "released_at"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) out.push(`unexpected:${k}`);
  return out;
}

/** Kilograms per unit for a mass unit code, or null for a unit that is not a mass. */
export function kgPerUnit(unit: string | null | undefined): number | null {
  const u = String(unit ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (["kg", "kgs", "kilogram", "kilograms"].includes(u)) return 1;
  if (["g", "gm", "gms", "gram", "grams"].includes(u)) return 0.001;
  if (["mg", "milligram", "milligrams"].includes(u)) return 0.000001;
  if (["t", "ton", "tonne", "tonnes", "mt"].includes(u)) return 1000;
  return null;
}

/** A pack size written as a mass ("25 kg", "25KG", "500 g", "0.5 Kg") in kilograms, else null. */
export function packSizeKg(packSize: string | null | undefined): number | null {
  const m = String(packSize ?? "").trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)\.?$/);
  if (!m) return null;
  const per = kgPerUnit(m[2]);
  const n = Number(m[1]);
  return per === null || !(n > 0) ? null : n * per;
}

/**
 * The quantity of an FG batch in kilograms: its unit is a mass → converted; otherwise (units,
 * pieces, drums…) the count × the SKU's pack size when that is written as a mass. null when
 * neither holds — the caller must not guess.
 */
export function fgQtyKg(qty: number, unit: string | null | undefined, packSize: string | null | undefined): number | null {
  if (!(qty > 0) || !Number.isFinite(qty)) return null;
  const per = kgPerUnit(unit);
  if (per !== null) return round4(qty * per);
  const pack = packSizeKg(packSize);
  return pack === null ? null : round4(qty * pack);
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/* ── 3. DOCS-001 wire shapes (ALEMBIC docs/bridge/COMPLIANCE_FACTS.md) ─────────────────────── */

export interface ProductRefWire { readonly sku?: string; readonly factory_sku?: string }

export interface QcResultWire {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string | null;
  readonly method?: string | null;
  readonly spec?: { readonly min?: string | null; readonly max?: string | null; readonly text?: string | null };
  readonly pass: boolean;
}

export interface QcBatchReleasedWire {
  readonly batch_no: string;
  readonly product_ref: ProductRefWire;
  readonly status: "passed" | "failed";
  readonly results: readonly QcResultWire[];
  readonly photos: ReadonlyArray<{ readonly url: string | null; readonly asset_ref: string | null; readonly caption: string | null; readonly result_key: string | null }>;
  readonly production_date: string;
  readonly best_before: string;
  readonly released_at: string;
  readonly qc_record_ref: string;
}

/** Specific gravity as it prints: at least three decimals, the fourth only when it is not 0
 *  (0.9950 → "0.995", 0.9953 → "0.9953", 1.5 → "1.500"). */
export function formatSg(n: number): string {
  const four = n.toFixed(4);
  return four.endsWith("0") ? n.toFixed(3) : four;
}

/** A flash point in °C, one decimal ("116.0"). */
export function formatFlashPoint(n: number): string {
  return n.toFixed(1);
}

export const QC_PHOTO_LIMIT = 8;

/**
 * The internal `qc.batch.released` record (lane/compliance-rp's builder) → the DOCS-001 wire
 * payload. `status` is the verdict ('failed' for a batch QC rejected — ALEMBIC wants both);
 * `factorySku` is the RawProd SKU code ALEMBIC maps through `bridge_sku_mapping`; `qcRecordRef` is
 * RawProd's own id for the QC record. Photos without an https url or an asset reference are
 * dropped (ALEMBIC refuses them); at most eight are sent.
 */
export function toQcBatchReleasedWire(
  internal: QcBatchReleasedPayload,
  opts: {
    status: "passed" | "failed";
    factorySku: string;
    qcRecordRef: string;
    /** The analyst's conformance calls (the internal record carries only the descriptions). */
    colourAppearancePass: boolean;
    odourPass: boolean;
  },
): QcBatchReleasedWire {
  const sg = internal.results.find((r) => r.test === "specific_gravity_20_4");
  const fp = internal.results.find((r) => r.test === "flash_point_pmcc");
  const results: QcResultWire[] = [
    { key: "odour", label: "Odour description", value: internal.odourDescription, pass: opts.odourPass },
    { key: "colour_appearance", label: "Colour and appearance", value: internal.colourAppearance, pass: opts.colourAppearancePass },
  ];
  if (sg) {
    results.push({
      key: "specific_gravity", label: "Specific Gravity at 20/4°C", value: formatSg(sg.value), unit: null, method: null,
      spec: { min: formatSg(sg.specMin), max: formatSg(sg.specMax) }, pass: sg.pass,
    });
  }
  if (fp) {
    results.push({
      key: "flash_point", label: "Zero Reference Flash Point", value: formatFlashPoint(fp.value), unit: "°C",
      method: "Pensky-Martens, closed cup",
      spec: { min: formatFlashPoint(fp.specMin), max: formatFlashPoint(fp.specMax) }, pass: fp.pass,
    });
  }
  const photos = internal.photos
    .map((p) => ({
      url: p.url && /^https:\/\//i.test(p.url) ? p.url : null,
      asset_ref: p.assetRef ?? null,
      caption: p.caption ?? null,
      result_key: null,
    }))
    .filter((p) => p.url !== null || p.asset_ref !== null)
    .slice(0, QC_PHOTO_LIMIT);
  return {
    batch_no: internal.batchNo,
    product_ref: { factory_sku: opts.factorySku },
    status: opts.status,
    results,
    photos,
    production_date: internal.productionDate,
    best_before: internal.bestBefore,
    released_at: internal.releasedAt,
    qc_record_ref: opts.qcRecordRef,
  };
}

const NUM = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ALEMBIC's `parseQcBatchReleased` rules, applied before the event is written ([] = accepted). */
export function checkQcBatchReleasedWire(p: QcBatchReleasedWire): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.batch_no, 64)) out.push("batch_no");
  if (!p.product_ref || (!isNonEmpty(p.product_ref.sku) && !isNonEmpty(p.product_ref.factory_sku))) out.push("product_ref");
  if (p.status !== "passed" && p.status !== "failed") out.push("status");
  if (!Array.isArray(p.results) || p.results.length === 0) out.push("results");
  (p.results ?? []).forEach((r, i) => {
    if (!isNonEmpty(r.key) || !isNonEmpty(r.label) || !isNonEmpty(r.value, 2000)) out.push(`results[${i}]`);
    if (typeof r.pass !== "boolean") out.push(`results[${i}].pass`);
    const min = r.spec?.min ?? null, max = r.spec?.max ?? null;
    if ((min !== null && !NUM.test(min)) || (max !== null && !NUM.test(max))) out.push(`results[${i}].spec`);
  });
  if (!Array.isArray(p.photos) || p.photos.length > QC_PHOTO_LIMIT) out.push("photos");
  (p.photos ?? []).forEach((ph, i) => {
    if (!ph.url && !ph.asset_ref) out.push(`photos[${i}]`);
    if (ph.url && !/^https:\/\//.test(ph.url)) out.push(`photos[${i}].url`);
  });
  if (!ISO_DATE.test(p.production_date ?? "")) out.push("production_date");
  if (!ISO_DATE.test(p.best_before ?? "") || p.best_before <= p.production_date) out.push("best_before");
  if (!isIsoInstant(p.released_at)) out.push("released_at");
  if (!isNonEmpty(p.qc_record_ref)) out.push("qc_record_ref");
  // A passed verdict must not contradict itself: every line passed and every number in spec.
  if (p.status === "passed") {
    for (const r of p.results ?? []) {
      if (r.pass !== true) out.push(`results.${r.key}.pass`);
      if (NUM.test(r.value)) {
        const v = Number(r.value);
        if (r.spec?.min != null && v < Number(r.spec.min)) out.push(`results.${r.key}.below_spec`);
        if (r.spec?.max != null && v > Number(r.spec.max)) out.push(`results.${r.key}.above_spec`);
      }
    }
  }
  return out;
}

/** The 26 EU-declarable allergens by CAS, in ALEMBIC's order (EU_ALLERGENS_26 on that side). */
export const EU_ALLERGEN_CAS_26: readonly string[] = [
  "127-51-5", "122-40-7", "101-85-9", "105-13-5", "100-51-6", "120-51-4", "103-41-3", "118-58-1",
  "80-54-6", "104-55-2", "104-54-1", "106-26-3", "106-22-9", "91-64-5", "97-53-0", "90028-67-4",
  "90028-68-5", "4602-84-0", "106-24-1", "101-86-0", "107-75-5", "31906-04-4", "97-54-1",
  "138-86-3", "126-90-9", "111-12-6",
];

/** The 18 IFRA categories ALEMBIC requires a limit for. */
export const IFRA_CATEGORY_CODES: readonly string[] = [
  "1", "2", "3", "4", "5A", "5B", "5C", "5D", "6", "7A", "7B", "8", "9", "10A", "10B", "11A", "11B", "12",
];

export interface CertificateCalculatedWire {
  readonly product_ref: ProductRefWire;
  readonly kind: "ifra" | "allergen";
  readonly amendment?: string | null;
  readonly formula_version: number;
  readonly formula_version_ref: string;
  readonly calculated_at: string;
  readonly values:
    | { readonly limits: Readonly<Record<string, string>> }
    | { readonly rows: ReadonlyArray<{ readonly cas: string; readonly natural: string; readonly synthetic: string; readonly total: string }> };
}

/** A percentage as a string ALEMBIC accepts (0–100, at most four decimals, no re-rounding up). */
export function pctString(n: number, decimals = 4): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 100) return "100";
  const factor = 10 ** decimals;
  const floored = Math.floor(n * factor + 1e-9) / factor;
  return String(Number(floored.toFixed(decimals)));
}

export class CertificateWireError extends Error {
  constructor(readonly problems: string[]) {
    super(`certificate cannot be sent to ALEMBIC: ${problems.join("; ")}`);
    this.name = "CertificateWireError";
  }
}

/**
 * The internal certificate record → the DOCS-001 wire payload. Throws `CertificateWireError` when
 * ALEMBIC would refuse it: an IFRA certificate with no amendment or without all 18 categories, an
 * allergen certificate without all 26 EU allergens (an allergen the Vault did not calculate is NOT
 * reported as absent — "could not read it" is not "absent"), or no formula version number.
 */
export function toCertificateCalculatedWire(
  internal: ComplianceCertificatePayload,
  opts: { factorySku: string; formulaVersion: number | null },
): CertificateCalculatedWire {
  const problems: string[] = [];
  if (!isNonEmpty(opts.factorySku)) problems.push("the product has no SKU code");
  const fv = opts.formulaVersion;
  if (typeof fv !== "number" || !Number.isInteger(fv) || fv < 1) problems.push("the formula version number is not known");
  let values: CertificateCalculatedWire["values"];
  if (internal.kind === "ifra") {
    if (!isNonEmpty(internal.amendment)) problems.push("IFRA amendment is not set in the Vault");
    const byCat = new Map((internal.values as readonly IfraCertificateValue[]).map((v) => [String(v.category).toUpperCase(), v.limitPct]));
    const limits: Record<string, string> = {};
    for (const c of IFRA_CATEGORY_CODES) {
      const v = byCat.get(c);
      if (v === undefined) problems.push(`IFRA category ${c} was not calculated`);
      else limits[c] = v >= 100 ? "100" : v.toFixed(2);
    }
    values = { limits };
  } else {
    const byCas = new Map((internal.values as readonly AllergenCertificateValue[]).map((v) => [v.cas, v]));
    const cell = (a: number | "A") => (a === "A" ? "A" : a <= 0 ? "A" : pctString(a));
    const rows = [];
    for (const cas of EU_ALLERGEN_CAS_26) {
      const v = byCas.get(cas);
      if (!v) { problems.push(`allergen ${cas} is not on the Vault's regulated list`); continue; }
      rows.push({ cas, natural: cell(v.natural), synthetic: cell(v.synthetic), total: cell(v.total) });
    }
    values = { rows };
  }
  if (problems.length > 0) throw new CertificateWireError(problems);
  return {
    product_ref: { factory_sku: opts.factorySku },
    kind: internal.kind,
    ...(internal.kind === "ifra" ? { amendment: internal.amendment } : {}),
    formula_version: fv as number,
    formula_version_ref: internal.formulaVersionRef,
    calculated_at: internal.calculatedAt,
    values,
  };
}

/* ── the printed location label ────────────────────────────────────────────────────────────── */

/**
 * One location as people read it on a label, a sheet, the shelf display and `fg.batch.received`
 * `rack`: rack, shelf, bin joined by '-'. A code that already carries its parent's code (the
 * quick "Rack layout" entry makes shelf `R01-S2` and bin `R01-S2-B3`) is not repeated:
 * ('R01','R01-S2','R01-S2-B3') → 'R01-S2-B3'; ('A','2','7') → 'A-2-7'; ('R01',null,null) → 'R01'.
 */
export function locationLabel(rack: string | null | undefined, shelf: string | null | undefined, bin: string | null | undefined): string | null {
  const parts: string[] = [];
  for (const code of [rack, shelf, bin]) {
    const c = (code ?? '').trim();
    if (!c) continue;
    const prev = parts.join('-');
    if (prev && (c === prev || c.startsWith(`${prev}-`))) { parts.length = 0; parts.push(c); continue; }
    const last = parts[parts.length - 1];
    if (last && c.startsWith(`${last}-`)) { parts[parts.length - 1] = c; continue; }
    parts.push(c);
  }
  return parts.length ? parts.join('-') : null;
}
