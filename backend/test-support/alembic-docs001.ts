/**
 * ALEMBIC's DOCS-001 receiver rules, copied VERBATIM (test fixture only) from
 * alembic packages/domain/src/compliance/documents.ts @ 80ffa1eb (lane/rc12; COMPLIANCE_FACTS.md) —
 * parseQcBatchReleased, coaEligibility, parseCertificateCalculated and the IFRA / allergen
 * validators they call. RawProd's contract tests run what RawProd emits through the receiver's
 * own parser, so "ALEMBIC would accept this" is proved here rather than assumed. If ALEMBIC changes
 * these rules, re-copy this file (and the tests will say what no longer matches).
 */
/* eslint-disable */
export const EU_ALLERGENS_26: ReadonlyArray<{ readonly name: string; readonly cas: string }> = Object.freeze([
  { name: "alpha-iso-Methylionone", cas: "127-51-5" },
  { name: "Amyl Cinnamal", cas: "122-40-7" },
  { name: "Amylcinnamyl Alcohol", cas: "101-85-9" },
  { name: "Anise Alcohol", cas: "105-13-5" },
  { name: "Benzyl Alcohol", cas: "100-51-6" },
  { name: "Benzyl Benzoate", cas: "120-51-4" },
  { name: "Benzyl Cinnamate", cas: "103-41-3" },
  { name: "Benzyl Salicylate", cas: "118-58-1" },
  { name: "Butylphenyl Methylpropional (Lilial)", cas: "80-54-6" },
  { name: "Cinnamal", cas: "104-55-2" },
  { name: "Cinnamyl Alcohol", cas: "104-54-1" },
  { name: "Citral", cas: "106-26-3" },
  { name: "Citronellol", cas: "106-22-9" },
  { name: "Coumarin", cas: "91-64-5" },
  { name: "Eugenol", cas: "97-53-0" },
  { name: "Evernia Furfuracea (Tree Moss) Extract", cas: "90028-67-4" },
  { name: "Evernia Prunastri (Oak Moss) Extract", cas: "90028-68-5" },
  { name: "Farnesol", cas: "4602-84-0" },
  { name: "Geraniol", cas: "106-24-1" },
  { name: "Hexyl Cinnamal", cas: "101-86-0" },
  { name: "Hydroxycitronellal", cas: "107-75-5" },
  { name: "Hydroxyisohexyl 3-Cyclohexene Carboxaldehyde (Lyral)", cas: "31906-04-4" },
  { name: "Isoeugenol", cas: "97-54-1" },
  { name: "Limonene", cas: "138-86-3" },
  { name: "Linalool", cas: "126-90-9" },
  { name: "Methyl 2-Octynoate", cas: "111-12-6" },
]);

/** 'A' (absent) or a percentage written as the person wrote it. */
export type AllergenValue = "A" | string;

export interface AllergenRow {
  readonly cas: string;
  readonly natural: AllergenValue;
  readonly synthetic: AllergenValue;
  readonly total: AllergenValue;
}

export interface AllergenData {
  readonly rows: readonly AllergenRow[];
}

const PCT = /^(?:100(?:\.0{1,4})?|\d{1,2}(?:\.\d{1,4})?)$/;

/** Accepts 'A'/'a'/'absent' as absent and a percentage 0..100 with up to four
 *  decimals, returned as written (so 0.70 prints as 0.70). Anything else is a
 *  typing error the form has to show -- never coerced to 'A', because "we
 *  could not read it" is not "absent". */
export function normaliseAllergenValue(raw: unknown): AllergenValue | null {
  if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/%$/, "").trim();
  if (/^(a|absent)$/i.test(v)) return "A";
  return PCT.test(v) ? v : null;
}

export function validateAllergenData(raw: unknown): { ok: true; data: AllergenData } | { ok: false; problems: string[] } {
  const rows = (raw as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return { ok: false, problems: ["rows must list all 26 allergens"] };
  const byCas = new Map<string, Record<string, unknown>>();
  for (const r of rows) if (r && typeof r === "object") byCas.set(String((r as Record<string, unknown>).cas ?? ""), r as Record<string, unknown>);
  const problems: string[] = [];
  const out: AllergenRow[] = [];
  for (const a of EU_ALLERGENS_26) {
    const r = byCas.get(a.cas);
    if (!r) { problems.push(`${a.name} (${a.cas}) has no entry`); continue; }
    const cells = { natural: normaliseAllergenValue(r.natural), synthetic: normaliseAllergenValue(r.synthetic), total: normaliseAllergenValue(r.total) };
    for (const [k, v] of Object.entries(cells)) if (v === null) problems.push(`${a.name}: ${k} must be a percentage or 'A'`);
    if (cells.natural && cells.synthetic && cells.total) out.push({ cas: a.cas, natural: cells.natural, synthetic: cells.synthetic, total: cells.total });
  }
  if (byCas.size > EU_ALLERGENS_26.length || [...byCas.keys()].some((c) => !EU_ALLERGENS_26.some((a) => a.cas === c))) {
    problems.push("rows may only name the 26 listed allergens");
  }
  return problems.length ? { ok: false, problems } : { ok: true, data: { rows: out } };
}


export const IFRA_CATEGORIES: ReadonlyArray<{ readonly code: string; readonly description: string }> = Object.freeze([
  { code: "1", description: "Products applied to the lips" },
  { code: "2", description: "Products applied to the axillae (armpit)" },
  { code: "3", description: "Products applied to the face/body using fingertips" },
  { code: "4", description: "Products related to fine fragrance" },
  { code: "5A", description: "Body lotion products applied to the body using the hands (palms), primarily leave-on" },
  { code: "5B", description: "Face moisturizer products applied to the face using the hands (palms), primarily leave-on" },
  { code: "5C", description: "Hand cream products applied to the hands using the hands (palms), primarily leave-on" },
  { code: "5D", description: "Baby Creams, baby Oils and baby talc" },
  { code: "6", description: "Products with oral and lip exposure" },
  { code: "7A", description: "Rinse-off products applied to the hair with some hand contact" },
  { code: "7B", description: "Leave-on products applied to the hair with some hand contact" },
  { code: "8", description: "Products with significant anogenital exposure" },
  { code: "9", description: "Products with body and hand exposure, primarily rinse off" },
  { code: "10A", description: "Household care excluding aerosol products (excluding aerosol/spray products)" },
  { code: "10B", description: "Household aerosol/spray products" },
  { code: "11A", description: "Products with intended skin contact but minimal transfer of fragrance to skin from inert substrate without UV exposure" },
  { code: "11B", description: "Products with intended skin contact but minimal transfer of fragrance to skin from inert substrate with potential UV exposure" },
  { code: "12", description: "Products not intended for direct skin contact, minimal or insignificant transfer to skin" },
]);

export interface IfraData {
  /** The amendment the limits were assessed under, e.g. "51st". Required. */
  readonly amendment: string;
  /** DD/MM/YYYY as printed ("Date Prepared: 31/08/2026"). */
  readonly datePrepared: string;
  /** category code -> percentage as written ("0.00", "25.00", "100"). */
  readonly limits: Readonly<Record<string, string>>;
}

export function normaliseIfraLimit(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/%$/, "").trim();
  return PCT.test(v) ? v : null;
}

/** ISO yyyy-mm-dd or dd/mm/yyyy -> dd/mm/yyyy, validated as a real date. */
export function normaliseDisplayDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let d: number, m: number, y: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (match) { y = +match[1]!; m = +match[2]!; d = +match[3]!; }
  else if ((match = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(s))) { d = +match[1]!; m = +match[2]!; y = +match[3]!; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

export function validateIfraData(raw: unknown): { ok: true; data: IfraData } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const amendment = typeof r.amendment === "string" ? r.amendment.trim() : "";
  if (!amendment) problems.push("amendment is required: a limit with no amendment is a claim about a document nobody has read");
  const datePrepared = normaliseDisplayDate(r.datePrepared);
  if (!datePrepared) problems.push("datePrepared must be a date");
  const src = (typeof r.limits === "object" && r.limits !== null ? r.limits : {}) as Record<string, unknown>;
  const limits: Record<string, string> = {};
  for (const c of IFRA_CATEGORIES) {
    const v = normaliseIfraLimit(src[c.code]);
    if (v === null) problems.push(`Category ${c.code} needs a level/limit percentage`);
    else limits[c.code] = v;
  }
  for (const k of Object.keys(src)) if (!IFRA_CATEGORIES.some((c) => c.code === k)) problems.push(`'${k}' is not an IFRA category`);
  return problems.length ? { ok: false, problems } : { ok: true, data: { amendment, datePrepared: datePrepared!, limits } };
}


export interface QcResult {
  /** Stable key: "specific_gravity", "flash_point", "colour_appearance",
   *  "odour", or any other the factory measures. */
  readonly key: string;
  readonly label: string;
  /** As measured, as text ("0.995", "116.0", "Deep Brown"). */
  readonly value: string;
  readonly unit: string | null;
  readonly method: string | null;
  /** Numeric range for a measurement; `text` for a descriptive spec. */
  readonly spec: { readonly min: string | null; readonly max: string | null; readonly text: string | null };
  /** The factory's verdict for this line. */
  readonly pass: boolean;
}

export interface QcBatchRelease {
  readonly batchNo: string;
  readonly productRef: { readonly sku: string | null; readonly factorySku: string | null };
  readonly status: "passed" | "failed";
  readonly results: readonly QcResult[];
  readonly photos: ReadonlyArray<{ readonly url: string | null; readonly assetRef: string | null; readonly caption: string | null; readonly resultKey: string | null }>;
  /** ISO yyyy-mm-dd. */
  readonly productionDate: string;
  readonly bestBefore: string;
  readonly releasedAt: string;
  /** RawProd's own id for the QC record, for the audit trail. */
  readonly qcRecordRef: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUM = /^-?\d+(?:\.\d+)?$/;

/** Structural validation of a `qc.batch.released` payload (snake_case wire
 *  names, see docs/bridge/COMPLIANCE_FACTS.md). */
export function parseQcBatchReleased(raw: unknown): { ok: true; release: QcBatchRelease } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const batchNo = str(r.batch_no);
  if (!batchNo || batchNo.length > 64) problems.push("batch_no is required");
  const pr = (typeof r.product_ref === "object" && r.product_ref ? r.product_ref : {}) as Record<string, unknown>;
  const productRef = { sku: str(pr.sku), factorySku: str(pr.factory_sku) };
  if (!productRef.sku && !productRef.factorySku) problems.push("product_ref needs sku or factory_sku");
  const status = r.status === "passed" || r.status === "failed" ? r.status : null;
  if (!status) problems.push("status must be 'passed' or 'failed'");
  const results: QcResult[] = [];
  if (!Array.isArray(r.results) || r.results.length === 0) problems.push("results must list at least one measurement");
  else r.results.forEach((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const spec = (typeof o.spec === "object" && o.spec ? o.spec : {}) as Record<string, unknown>;
    const key = str(o.key), label = str(o.label), value = str(o.value);
    if (!key || !label || !value) problems.push(`results[${i}] needs key, label and value`);
    if (typeof o.pass !== "boolean") problems.push(`results[${i}].pass must be true or false`);
    const min = str(spec.min), max = str(spec.max);
    if ((min && !NUM.test(min)) || (max && !NUM.test(max))) problems.push(`results[${i}].spec min/max must be numbers written as text`);
    results.push({ key: key ?? "", label: label ?? "", value: value ?? "", unit: str(o.unit), method: str(o.method), spec: { min, max, text: str(spec.text) }, pass: o.pass === true });
  });
  const photos = (Array.isArray(r.photos) ? r.photos : []).map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return { url: str(o.url), assetRef: str(o.asset_ref), caption: str(o.caption), resultKey: str(o.result_key) };
  });
  photos.forEach((p, i) => {
    if (!p.url && !p.assetRef) problems.push(`photos[${i}] needs url or asset_ref`);
    if (p.url && !/^https:\/\//.test(p.url)) problems.push(`photos[${i}].url must be https`);
  });
  const productionDate = str(r.production_date), bestBefore = str(r.best_before);
  if (!productionDate || !ISO_DATE.test(productionDate) || !normaliseDisplayDate(productionDate)) problems.push("production_date must be yyyy-mm-dd");
  if (!bestBefore || !ISO_DATE.test(bestBefore) || !normaliseDisplayDate(bestBefore)) problems.push("best_before must be yyyy-mm-dd");
  if (productionDate && bestBefore && bestBefore <= productionDate) problems.push("best_before must be after production_date");
  const releasedAt = str(r.released_at);
  if (!releasedAt || Number.isNaN(Date.parse(releasedAt))) problems.push("released_at must be a timestamp");
  const qcRecordRef = str(r.qc_record_ref);
  if (!qcRecordRef) problems.push("qc_record_ref is required");
  if (problems.length) return { ok: false, problems };
  return { ok: true, release: { batchNo: batchNo!, productRef, status: status!, results, photos, productionDate: productionDate!, bestBefore: bestBefore!, releasedAt: releasedAt!, qcRecordRef: qcRecordRef! } };
}

export type CoaEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Whether a batch may be certified. Fails closed: no release, a failed
 *  release, a line the factory marked failed, or a number outside its own
 *  printed range each refuse -- the last one because a COA that prints
 *  "116.0 °C" beside "110.0 - 115.0 °C" is a document that contradicts itself,
 *  whatever the factory's verdict said. */
export function coaEligibility(release: QcBatchRelease | null, batchNo: string): CoaEligibility {
  if (!release) return { ok: false, reason: `No QC release from the factory for batch ${batchNo}: a COA cannot be issued until QC passes.` };
  if (release.status !== "passed") return { ok: false, reason: `Batch ${batchNo} failed factory QC: a COA cannot be issued.` };
  for (const r of release.results) {
    if (!r.pass) return { ok: false, reason: `Batch ${batchNo}: ${r.label} is marked failed by QC.` };
    if (NUM.test(r.value)) {
      const v = Number(r.value);
      if (r.spec.min !== null && v < Number(r.spec.min)) return { ok: false, reason: `Batch ${batchNo}: ${r.label} ${r.value} is below its specification ${r.spec.min}.` };
      if (r.spec.max !== null && v > Number(r.spec.max)) return { ok: false, reason: `Batch ${batchNo}: ${r.label} ${r.value} is above its specification ${r.spec.max}.` };
    }
  }
  return { ok: true };
}


export interface CalculatedCertificate {
  readonly productRef: { readonly sku: string | null; readonly factorySku: string | null };
  readonly kind: "ifra" | "allergen";
  /** IFRA: the amendment assessed under. Allergen: null. */
  readonly amendment: string | null;
  /** The formula version number printed as "Calculated from formula vN". */
  readonly formulaVersion: number;
  readonly formulaVersionRef: string;
  readonly calculatedAt: string;
  readonly ifra: IfraData | null;
  readonly allergen: AllergenData | null;
}

export function parseCertificateCalculated(raw: unknown): { ok: true; calc: CalculatedCertificate } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const pr = (typeof r.product_ref === "object" && r.product_ref ? r.product_ref : {}) as Record<string, unknown>;
  const productRef = { sku: str(pr.sku), factorySku: str(pr.factory_sku) };
  if (!productRef.sku && !productRef.factorySku) problems.push("product_ref needs sku or factory_sku");
  const kind = r.kind === "ifra" || r.kind === "allergen" ? r.kind : null;
  if (!kind) problems.push("kind must be 'ifra' or 'allergen'");
  const formulaVersion = r.formula_version;
  if (typeof formulaVersion !== "number" || !Number.isInteger(formulaVersion) || formulaVersion < 1) problems.push("formula_version must be a positive integer");
  const formulaVersionRef = str(r.formula_version_ref);
  if (!formulaVersionRef || formulaVersionRef.length > 200) problems.push("formula_version_ref is required (opaque, no formula content)");
  const calculatedAt = str(r.calculated_at);
  if (!calculatedAt || Number.isNaN(Date.parse(calculatedAt))) problems.push("calculated_at must be a timestamp");
  const values = (typeof r.values === "object" && r.values ? r.values : {}) as Record<string, unknown>;
  let ifra: IfraData | null = null, allergen: AllergenData | null = null;
  if (kind === "ifra") {
    const v = validateIfraData({ amendment: r.amendment, datePrepared: calculatedAt ? calculatedAt.slice(0, 10) : null, limits: values.limits });
    if (v.ok) ifra = v.data; else problems.push(...v.problems);
  } else if (kind === "allergen") {
    const v = validateAllergenData({ rows: values.rows });
    if (v.ok) allergen = v.data; else problems.push(...v.problems);
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, calc: { productRef, kind: kind!, amendment: kind === "ifra" ? ifra!.amendment : null, formulaVersion: formulaVersion as number, formulaVersionRef: formulaVersionRef!, calculatedAt: calculatedAt!, ifra, allergen } };
}

