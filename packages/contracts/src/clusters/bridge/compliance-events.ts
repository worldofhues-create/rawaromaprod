/**
 * Compliance-document events, RawProd -> ALEMBIC (owner rulings 2026-09-28; wire contract in
 * docs/bridge/EVENT_CONTRACT.md, "Compliance documents"). Pure: no I/O, no NestJS — shared by
 * the two emitters (the factory QC release in @ra/cluster-production, the Vault certificate
 * sync in backend/api) and by the tests that pin the shapes.
 *
 *   qc.batch.released                  a finished (oil) batch passed QC and was released: the
 *                                      data a Certificate of Analysis is printed from.
 *   compliance.certificate.calculated  the Vault calculated an IFRA or allergen certificate for
 *                                      a product's current approved formula version.
 *
 * NOTHING HERE MAY CARRY FORMULA CONTENT. A certificate is the calculated numbers only (allergen
 * totals per regulated allergen, IFRA max use level per category) plus an OPAQUE
 * `formulaVersionRef` — never an ingredient, a material id, a percentage, a formula id/name or a
 * formula version id. `assertNoFormulaContent` is the last gate every payload passes before it
 * is written to the bridge outbox; it refuses rather than strips, so a bug shows up as a failed
 * emission, never as a quietly-leaked field.
 */

export const QC_BATCH_RELEASED = 'qc.batch.released' as const;
export const COMPLIANCE_CERTIFICATE_CALCULATED = 'compliance.certificate.calculated' as const;
/** FACTORY-DOCS: a lab's GC-MS report attached to a finished oil batch (ALEMBIC
 *  docs/plan/program/documents-automation.md > "What RawProd must send", fact 3). */
export const QC_GCMS_ATTACHED = 'qc.gcms.attached' as const;
export const COMPLIANCE_EVENT_TYPES = [QC_BATCH_RELEASED, COMPLIANCE_CERTIFICATE_CALCULATED, QC_GCMS_ATTACHED] as const;

/** The envelope `aggregate.type` each compliance event is reported under — DOCS-001 (ALEMBIC
 *  docs/bridge/COMPLIANCE_FACTS.md): `qc_batch` + RawProd's batch COA uuid for a QC verdict,
 *  `product` + RawProd's product uuid for a calculation (lane produce reconciled the latter, which
 *  lane/compliance-rp had reported as `compliance_certificate` + an emission id). */
export const COMPLIANCE_AGGREGATE_TYPES: Record<(typeof COMPLIANCE_EVENT_TYPES)[number], string> = {
  [QC_BATCH_RELEASED]: 'qc_batch',
  [COMPLIANCE_CERTIFICATE_CALCULATED]: 'product',
  // FACTORY-DOCS: the same aggregate as the batch's QC verdict (RawProd's batch COA uuid), so the relay
  // holds a GC-MS fact behind a parked release of the same batch rather than sending it first.
  [QC_GCMS_ATTACHED]: 'qc_batch',
};

/* ── qc.batch.released ─────────────────────────────────────────────────────────────────────── */

export const COA_TEST_SPECIFIC_GRAVITY = 'specific_gravity_20_4' as const;
export const COA_TEST_FLASH_POINT = 'flash_point_pmcc' as const;

export interface CoaTestResult {
  readonly test: typeof COA_TEST_SPECIFIC_GRAVITY | typeof COA_TEST_FLASH_POINT;
  readonly value: number;
  /** null for specific gravity (a dimensionless ratio at 20/4 °C); '°C' for the flash point. */
  readonly unit: string | null;
  readonly specMin: number;
  readonly specMax: number;
  readonly pass: boolean;
}

export interface CoaPhoto {
  /** An absolute http(s) URL, when the photo's stored document path is one. */
  readonly url?: string;
  /** `document:<platform.document_master id>` — RawProd's asset reference for the photo. */
  readonly assetRef?: string;
  readonly caption: string | null;
}

export interface QcBatchReleasedPayload {
  readonly batchNo: string;
  /** RawProd's product code (packaging.product_master.product_code). */
  readonly productRef: string;
  /** Every packaging.product_sku.sku_code of that product — the values ALEMBIC's SKU mapping
   *  holds as `mapped_sku` on the production-requirement bridge. */
  readonly skuCodes: readonly string[];
  readonly results: readonly CoaTestResult[];
  readonly colourAppearance: string;
  readonly odourDescription: string;
  readonly photos: readonly CoaPhoto[];
  /** yyyy-mm-dd */
  readonly productionDate: string;
  /** yyyy-mm-dd — productionDate + the product's shelf life (months). */
  readonly bestBefore: string;
  /** ISO 8601 UTC */
  readonly releasedAt: string;
  /** RawProd user id of the QC releaser. */
  readonly releasedBy: string;
  readonly releasedByName: string | null;
}

/* ── compliance.certificate.calculated ─────────────────────────────────────────────────────── */

/** 'A' = absent (zero, or below the Vault's reporting threshold). Numbers are % in the fragrance. */
export type AllergenAmount = number | 'A';

export interface AllergenCertificateValue {
  readonly name: string;
  readonly cas: string;
  readonly natural: AllergenAmount;
  readonly synthetic: AllergenAmount;
  readonly total: AllergenAmount;
}

export interface IfraCertificateValue {
  /** '1'..'12' incl. 5A-5D, 7A/7B, 10A/10B, 11A/11B. */
  readonly category: string;
  /** Maximum use level of the fragrance in a product of this category, % (0..100). */
  readonly limitPct: number;
}

export type CertificateKind = 'ifra' | 'allergen';

export interface ComplianceCertificatePayload {
  readonly productRef: string;
  readonly skuCodes: readonly string[];
  readonly kind: CertificateKind;
  /** IFRA: the amendment the restriction data is for (e.g. "51"). Allergen: the regulated-list
   *  reference the Vault is configured with. null when the regulatory team has not set one. */
  readonly amendment: string | null;
  readonly values: readonly AllergenCertificateValue[] | readonly IfraCertificateValue[];
  /** ISO 8601 UTC */
  readonly calculatedAt: string;
  /** Opaque, Vault-keyed reference to the formula version the numbers were calculated from. It
   *  identifies "same version / new version" for ALEMBIC and nothing else. */
  readonly formulaVersionRef: string;
}

/* ── the no-formula-content gate ───────────────────────────────────────────────────────────── */

/** Keys that may never appear anywhere inside a compliance payload, at any depth. Compared
 *  case-insensitively with `_`/`-` removed, so `material_id`, `materialId` and `MATERIAL-ID` are
 *  all the same key. */
const FORBIDDEN_KEYS = new Set(
  [
    'materialId', 'materialCode', 'materialName', 'material', 'materials',
    'ingredient', 'ingredients', 'ingredientPct', 'percentage', 'percent', 'pct',
    'formula', 'formulaId', 'formulaCode', 'formulaName', 'formulaVersionId', 'versionNumber',
    'recipe', 'bom', 'composition', 'rmAlias', 'aliasName', 'sequenceNo', 'encPayload',
  ].map((k) => k.toLowerCase().replace(/[_-]/g, '')),
);

export class FormulaContentError extends Error {
  constructor(readonly path: string) {
    super(`compliance payload refused: "${path}" would carry formula content across the bridge`);
    this.name = 'FormulaContentError';
  }
}

/** Throws `FormulaContentError` if any key, at any depth, names formula content. */
export function assertNoFormulaContent(payload: unknown, path = 'payload'): void {
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoFormulaContent(v, `${path}[${i}]`));
    return;
  }
  if (payload === null || typeof payload !== 'object') return;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase().replace(/[_-]/g, ''))) throw new FormulaContentError(`${path}.${k}`);
    assertNoFormulaContent(v, `${path}.${k}`);
  }
}

/* ── shape validation (what ALEMBIC may rely on) ───────────────────────────────────────────── */

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isYmd = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.includes('T');
const isNonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const isAmount = (v: unknown) => v === 'A' || (isFiniteNumber(v) && v >= 0 && v <= 100);

/** Problems with a qc.batch.released payload ([] = valid). */
export function validateQcBatchReleased(p: QcBatchReleasedPayload): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.batchNo)) out.push('batchNo');
  if (!isNonEmpty(p.productRef)) out.push('productRef');
  if (!Array.isArray(p.skuCodes) || p.skuCodes.some((s) => !isNonEmpty(s))) out.push('skuCodes');
  const tests = (p.results ?? []).map((r) => r.test).sort();
  if (tests.join(',') !== [COA_TEST_FLASH_POINT, COA_TEST_SPECIFIC_GRAVITY].sort().join(',')) out.push('results');
  for (const r of p.results ?? []) {
    if (![r.value, r.specMin, r.specMax].every(isFiniteNumber) || typeof r.pass !== 'boolean') out.push(`results.${r.test}`);
    if (r.pass !== true) out.push(`results.${r.test}.pass`); // only a passed batch is ever released
  }
  if (!isNonEmpty(p.colourAppearance)) out.push('colourAppearance');
  if (!isNonEmpty(p.odourDescription)) out.push('odourDescription');
  if (!Array.isArray(p.photos) || p.photos.some((ph) => !ph.url && !ph.assetRef)) out.push('photos');
  if (!isYmd(p.productionDate)) out.push('productionDate');
  if (!isYmd(p.bestBefore) || p.bestBefore <= p.productionDate) out.push('bestBefore');
  if (!isIso(p.releasedAt)) out.push('releasedAt');
  if (!isNonEmpty(p.releasedBy)) out.push('releasedBy');
  return out;
}

/** Problems with a compliance.certificate.calculated payload ([] = valid). */
export function validateComplianceCertificate(p: ComplianceCertificatePayload): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.productRef)) out.push('productRef');
  if (!Array.isArray(p.skuCodes)) out.push('skuCodes');
  if (p.kind !== 'ifra' && p.kind !== 'allergen') out.push('kind');
  if (!(p.amendment === null || isNonEmpty(p.amendment))) out.push('amendment');
  if (!Array.isArray(p.values) || p.values.length === 0) out.push('values');
  else if (p.kind === 'allergen') {
    for (const v of p.values as readonly AllergenCertificateValue[]) {
      if (!isNonEmpty(v.name) || !isNonEmpty(v.cas) || ![v.natural, v.synthetic, v.total].every(isAmount)) out.push(`values.${v.cas}`);
    }
  } else {
    for (const v of p.values as readonly IfraCertificateValue[]) {
      if (!isNonEmpty(v.category) || !isFiniteNumber(v.limitPct) || v.limitPct < 0 || v.limitPct > 100) out.push(`values.${v.category}`);
    }
  }
  if (!isIso(p.calculatedAt)) out.push('calculatedAt');
  if (!/^fvr_[0-9a-f]{32}$/.test(p.formulaVersionRef ?? '')) out.push('formulaVersionRef');
  return out;
}

/* ── qc.gcms.attached (FACTORY-DOCS) ───────────────────────────────────────────────────────── */

/** The largest GC-MS PDF QC may attach (5 MB). It is uploaded as itself, outside the console tunnel,
 *  on its own authenticated route (api upload-body-limits.ts). */
export const GCMS_MAX_BYTES = 5 * 1024 * 1024;

/** How long a signed GC-MS file link lives. ALEMBIC asks for at least 15 minutes and fetches the
 *  file on receipt; the relay mints a fresh link at every delivery attempt, so a retry hours later
 *  still carries a live one. */
export const GCMS_FILE_URL_TTL_SECONDS = 60 * 60;

/** The relay's transport metadata on a queued `qc.gcms.attached` row: the report whose file the
 *  relay links at send time. Stripped before the body is signed; never reaches ALEMBIC. */
export const GCMS_REPORT_META_KEY = '_gcms_report_id' as const;

/** The DOCS wire shape ALEMBIC parses (`parseQcGcmsAttached`). snake_case; the file is reached at
 *  `file.url`, a signed https link (ALEMBIC cannot fetch a RawProd asset_ref). */
export interface QcGcmsAttachedWire {
  readonly batch_no: string;
  readonly product_ref: { readonly factory_sku: string };
  readonly file: { readonly url: string };
  /** Lower-case hex SHA-256 of the PDF bytes. */
  readonly sha256: string;
  readonly lab_name: string;
  readonly report_ref: string;
  /** yyyy-mm-dd */
  readonly analysed_on: string;
  /** ISO 8601 UTC; the latest wins per batch on ALEMBIC's side. */
  readonly attached_at: string;
}

/** True when the bytes start with the PDF header ALEMBIC checks (`%PDF-`). */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/** Problems ALEMBIC would refuse a `qc.gcms.attached` wire payload for ([] = valid). `requireUrl`
 *  is false for the queued row, whose link the relay adds at send time. */
export function checkQcGcmsAttachedWire(w: Partial<QcGcmsAttachedWire>, opts: { requireUrl?: boolean } = {}): string[] {
  const out: string[] = [];
  const s = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!s(w.batch_no, 64)) out.push('batch_no');
  if (!s(w.product_ref?.factory_sku, 200)) out.push('product_ref.factory_sku');
  if (opts.requireUrl !== false && !(typeof w.file?.url === 'string' && /^https:\/\//.test(w.file.url))) out.push('file.url');
  if (!(typeof w.sha256 === 'string' && /^[0-9a-f]{64}$/.test(w.sha256))) out.push('sha256');
  if (!s(w.lab_name, 200)) out.push('lab_name');
  if (!s(w.report_ref, 120)) out.push('report_ref');
  if (!isYmd(w.analysed_on)) out.push('analysed_on');
  if (!isIso(w.attached_at)) out.push('attached_at');
  return out;
}
