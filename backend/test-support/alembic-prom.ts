/**
 * ALEMBIC's process-promise receiver rules, copied VERBATIM (test fixture only) from
 * alembic packages/domain/src/promises/facts.ts (lane/prom; PROM-2, PROM-3, PROM-5). RawProd's promise tests run
 * what RawProd emits through the receiver's own parser, so "ALEMBIC would accept this" is proved here
 * rather than assumed. If ALEMBIC changes these rules, re-copy this file.
 */
/* eslint-disable */
/* The process-promise facts from the factory (LD-85, docs/plan/program/process-promises.md).
 *
 * The storefront prints "Every batch rests 45 days between QC 1 and QC 2" only when production
 * enforces it and every lot on sale carries the record that proves it. These parsers take the
 * records RawProd sends over the signed bridge; they are pure, so the contract is tested in
 * bare Node, and RawProd runs a verbatim copy of each against what it emits.
 *
 *   PROM-2  `batch.rest.recorded`   one maceration run closed on release: when the rest
 *           started and ended, the days rested, the branch rule it rested under, and whether a
 *           second person approved an early release.
 *   PROM-3  the block `qc.batch.released` gains: each QC 1 / QC 2 round, the retained reference
 *           the last one compared with, and whether this batch IS a product's reference. Every
 *           field optional, so a release from an older sender still parses (`promise: null`).
 *
 * Rule 3: a missing record is null and the lot page says "Not on file"; nothing here fills
 * one in. D-1 (formula secrecy): the only identities are the batch number and an opaque run
 * reference -- no material, supplier, formula or percentage is accepted, and a payload that
 * carries a key naming one is refused rather than stored.
 */

export const BATCH_REST_RECORDED = "batch.rest.recorded" as const;

/** system-led-operations.md 3.3: the reason codes for an override away from caution. */
export const EARLY_RELEASE_REASON_CODES = [
  "customer_commitment",
  "confirmed_outside_system",
  "system_data_wrong",
  "supplier_or_carrier_constraint",
  "instructed_by_manager",
  "other",
] as const;
export type EarlyReleaseReasonCode = (typeof EARLY_RELEASE_REASON_CODES)[number];

export interface BatchRestRecord {
  readonly batchNo: string;
  readonly oilBatchRef: string;
  readonly startedAt: string;
  readonly closedAt: string;
  readonly daysRested: number;
  readonly requiredDays: number;
  readonly ruleDays: number;
  /** 0 = the factory's registry default, before any version of the rule was published. */
  readonly ruleVersion: number;
  readonly earlyRelease: boolean;
  readonly earlyReleaseReasonCode: EarlyReleaseReasonCode | null;
  readonly temperature: { readonly zoneRef: string; readonly readingsExpected: number; readonly readingsOnFile: number } | null;
}

/* Keys that would carry formula content across the boundary (D-1). Compared case- and
   separator-insensitively, at any depth. */
const FORMULA_KEYS = new Set([
  "material", "materials", "materialname", "materialcode", "materialid", "ingredient", "ingredients",
  "supplier", "suppliername", "vendor", "formula", "formulaid", "formulaname", "recipe", "bom",
  "composition", "percentage", "percent", "pct", "cas",
].map((k) => k.replace(/[_-]/g, "")));

/** The path of the first key naming formula content, or null. */
export function formulaContentKey(v: unknown, path = "payload"): string | null {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const p = formulaContentKey(v[i], `${path}[${i}]`); if (p) return p; }
    return null;
  }
  if (v === null || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (FORMULA_KEYS.has(k.toLowerCase().replace(/[_-]/g, ""))) return `${path}.${k}`;
    const p = formulaContentKey(x, `${path}.${k}`);
    if (p) return p;
  }
  return null;
}

const ISO_INSTANT = (v: unknown): v is string => typeof v === "string" && v.includes("T") && !Number.isNaN(Date.parse(v));
const count = (v: unknown, min = 0, max = 100_000): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

const REST_KEYS = new Set(["batch_no", "oil_batch_ref", "started_at", "closed_at", "days_rested", "required_days", "rule_days",
  "rule_version", "early_release", "early_release_reason_code", "temperature"]);

/** Structural validation of a `batch.rest.recorded` payload (snake_case wire names). Unknown
 *  extra keys are refused: the record is small and a new field is a contract change. */
export function parseBatchRestRecorded(raw: unknown): { ok: true; record: BatchRestRecord } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const leak = formulaContentKey(r);
  if (leak) problems.push(`${leak} would carry formula content`);
  for (const k of Object.keys(r)) if (!REST_KEYS.has(k)) problems.push(`unexpected field ${k}`);
  const batchNo = text(r.batch_no, 64);
  if (!batchNo) problems.push("batch_no is required");
  const oilBatchRef = text(r.oil_batch_ref, 64);
  if (!oilBatchRef) problems.push("oil_batch_ref is required");
  if (!ISO_INSTANT(r.started_at)) problems.push("started_at must be a timestamp");
  if (!ISO_INSTANT(r.closed_at)) problems.push("closed_at must be a timestamp");
  else if (ISO_INSTANT(r.started_at) && Date.parse(r.closed_at) < Date.parse(r.started_at)) problems.push("closed_at must not be before started_at");
  if (!count(r.days_rested)) problems.push("days_rested must be a whole number of days");
  if (!count(r.required_days, 1, 365)) problems.push("required_days must be 1 to 365");
  if (!count(r.rule_days, 1, 365)) problems.push("rule_days must be 1 to 365");
  if (!count(r.rule_version)) problems.push("rule_version must be a whole number");
  if (typeof r.early_release !== "boolean") problems.push("early_release must be true or false");
  const code = r.early_release_reason_code;
  if (r.early_release === true && !(EARLY_RELEASE_REASON_CODES as readonly unknown[]).includes(code)) problems.push("an early release needs its reason code");
  if (r.early_release === false && code !== null) problems.push("early_release_reason_code must be null without an early release");
  if (r.early_release === false && count(r.days_rested) && count(r.required_days, 1, 365) && r.days_rested < r.required_days) {
    problems.push("a rest shorter than required is an early release");
  }
  let temperature: BatchRestRecord["temperature"] = null;
  if (r.temperature !== null) {
    const t = (typeof r.temperature === "object" && r.temperature ? r.temperature : {}) as Record<string, unknown>;
    const zoneRef = text(t.zone_ref, 64);
    if (!zoneRef || !count(t.readings_expected) || !count(t.readings_on_file) || (t.readings_on_file as number) > (t.readings_expected as number)) {
      problems.push("temperature must be null or { zone_ref, readings_expected, readings_on_file }");
    } else temperature = { zoneRef, readingsExpected: t.readings_expected as number, readingsOnFile: t.readings_on_file as number };
  }
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    record: {
      batchNo: batchNo!, oilBatchRef: oilBatchRef!, startedAt: r.started_at as string, closedAt: r.closed_at as string,
      daysRested: r.days_rested as number, requiredDays: r.required_days as number, ruleDays: r.rule_days as number,
      ruleVersion: r.rule_version as number, earlyRelease: r.early_release as boolean,
      earlyReleaseReasonCode: (r.early_release ? code : null) as EarlyReleaseReasonCode | null, temperature,
    },
  };
}

/* ── PROM-3: the QC stages and the retained reference on `qc.batch.released` ───────────── */

export const QC_STAGES = ["QC1", "QC2"] as const;
export type QcStage = (typeof QC_STAGES)[number];
const QC_DECISIONS = ["APPROVE", "REWORK", "HOLD_RETEST", "REJECT", "REVIEW", "HOLD_CAPA"] as const;

export interface QcStageRecord {
  readonly stage: QcStage;
  readonly roundRef: string;
  readonly decidedAt: string;
  readonly decision: (typeof QC_DECISIONS)[number];
}
export interface QcReferenceRecord {
  readonly ref: string;
  readonly sampleCode: string;
  readonly retainedAt: string | null;
}
export interface QcPromiseBlock {
  readonly stages: readonly QcStageRecord[];
  readonly reference: QcReferenceRecord | null;
  readonly isReferenceBatch: boolean;
}

/** The PROM-3 fields of a `qc.batch.released` payload. `block` is null when the sender sent none of
 *  them (an older RawProd): the release still parses, and the lot page says "Not on file". */
export function parseQcPromiseBlock(r: Record<string, unknown>): { ok: true; block: QcPromiseBlock | null } | { ok: false; problems: string[] } {
  if (r.stages === undefined && r.reference === undefined && r.is_reference_batch === undefined) return { ok: true, block: null };
  const problems: string[] = [];
  const stages: QcStageRecord[] = [];
  if (r.stages !== undefined) {
    if (!Array.isArray(r.stages) || r.stages.length > 50) problems.push("stages must be a list of at most 50 rounds");
    else r.stages.forEach((x, i) => {
      const o = (typeof x === "object" && x ? x : {}) as Record<string, unknown>;
      const roundRef = text(o.round_ref, 64);
      if (!(QC_STAGES as readonly unknown[]).includes(o.stage) || !roundRef || !ISO_INSTANT(o.decided_at) || !(QC_DECISIONS as readonly unknown[]).includes(o.decision)) {
        problems.push(`stages[${i}] needs stage QC1|QC2, round_ref, decided_at and a decision`);
      } else stages.push({ stage: o.stage as QcStage, roundRef, decidedAt: o.decided_at as string, decision: o.decision as QcStageRecord["decision"] });
    });
  }
  let reference: QcReferenceRecord | null = null;
  if (r.reference !== undefined && r.reference !== null) {
    const o = (typeof r.reference === "object" ? r.reference : {}) as Record<string, unknown>;
    const ref = text(o.ref, 80), sampleCode = text(o.sample_code, 50);
    if (!ref || !sampleCode || !(o.retained_at === null || ISO_INSTANT(o.retained_at))) problems.push("reference needs ref, sample_code and retained_at (or null)");
    else reference = { ref, sampleCode, retainedAt: (o.retained_at as string | null) ?? null };
  }
  if (r.is_reference_batch !== undefined && typeof r.is_reference_batch !== "boolean") problems.push("is_reference_batch must be true or false");
  const leak = formulaContentKey({ stages: r.stages, reference: r.reference });
  if (leak) problems.push(`${leak} would carry formula content`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, block: { stages, reference, isReferenceBatch: r.is_reference_batch === true } };
}

/* ── PROM-3: a batch becomes a product's retained reference ─────────────────────────────────
 *
 * `qc.reference.established` is sent when a second person approves a batch's retained sample as
 * its product's reference. A reference is proposed from a batch that already passed QC 2, so its
 * own `qc.batch.released` has usually gone out before the approval and said is_reference_batch
 * false. This fact is what lets that lot's page say "This batch is the retained reference for this
 * code and grade" instead of "Not on file". It never claims a comparison: the reference batch
 * compared with nothing. */

export const QC_REFERENCE_ESTABLISHED = "qc.reference.established" as const;

export interface QcReferenceEstablished {
  readonly batchNo: string;
  readonly oilBatchRef: string;
  readonly reference: QcReferenceRecord;
  readonly establishedAt: string;
  /** The reference this one replaced (retired with a reason on the factory's side), or null. */
  readonly replacesRef: string | null;
}

const REFERENCE_KEYS = new Set(["batch_no", "oil_batch_ref", "reference", "established_at", "replaces_ref"]);

/** Structural validation of a `qc.reference.established` payload (snake_case wire names). Unknown
 *  keys are refused, as for `batch.rest.recorded`: a new field is a contract change. */
export function parseQcReferenceEstablished(raw: unknown): { ok: true; record: QcReferenceEstablished } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const leak = formulaContentKey(r);
  if (leak) problems.push(`${leak} would carry formula content`);
  for (const k of Object.keys(r)) if (!REFERENCE_KEYS.has(k)) problems.push(`unexpected field ${k}`);
  const batchNo = text(r.batch_no, 64);
  if (!batchNo) problems.push("batch_no is required");
  const oilBatchRef = text(r.oil_batch_ref, 64);
  if (!oilBatchRef) problems.push("oil_batch_ref is required");
  if (!ISO_INSTANT(r.established_at)) problems.push("established_at must be a timestamp");
  let reference: QcReferenceRecord | null = null;
  const o = (typeof r.reference === "object" && r.reference !== null && !Array.isArray(r.reference) ? r.reference : null) as Record<string, unknown> | null;
  if (o) {
    for (const k of Object.keys(o)) if (!["ref", "sample_code", "retained_at"].includes(k)) problems.push(`unexpected field reference.${k}`);
    const ref = text(o.ref, 80), sampleCode = text(o.sample_code, 50);
    if (!ref || !sampleCode || !(o.retained_at === null || ISO_INSTANT(o.retained_at))) problems.push("reference needs ref, sample_code and retained_at (or null)");
    else reference = { ref, sampleCode, retainedAt: (o.retained_at as string | null) ?? null };
  } else problems.push("reference is required: the retained bottle this batch became");
  const replacesRef = r.replaces_ref === null ? null : text(r.replaces_ref, 80);
  if (r.replaces_ref !== null && !replacesRef) problems.push("replaces_ref must be a reference code or null");
  if (replacesRef && reference && replacesRef === reference.ref) problems.push("a reference cannot replace itself");
  if (problems.length) return { ok: false, problems };
  return { ok: true, record: { batchNo: batchNo!, oilBatchRef: oilBatchRef!, reference: reference!, establishedAt: r.established_at as string, replacesRef } };
}

/* ── PROM-5: continuity, and a change of material ────────────────────────────────────────────
 *
 * "Reorder the same code, grade and pack, and get the same oil" and "If a raw material changes, we
 * tell you before your next order". The factory defines the same oil once: the same formula version,
 * the same raw-material identities each from the same supplier(s), and the same retained reference.
 * It sends an OPAQUE key over those three (ck1:sha256), never the inputs:
 *
 *   `product.continuity.current`   the product's key changed (its first keyed batch, a change, or a
 *                                  new reference). `first_batch_no` names the first batch under it.
 *   `product.material.changed`     one kind of change: formula_version | supplier | reference, from
 *                                  one key to another, recorded at compounding -- before any lot
 *                                  under the new key can be released, because every batch rests.
 *
 * `grade` is null from the factory today: a RawProd product row is one code and grade, so its code
 * carries both. D-1: a key naming a material, supplier, formula, CAS number or percentage is refused,
 * and no person crosses. PROM-9 builds the customer notices from the change records. */

export const PRODUCT_CONTINUITY_CURRENT = "product.continuity.current" as const;
export const PRODUCT_MATERIAL_CHANGED = "product.material.changed" as const;
export const MATERIAL_CHANGE_KINDS = ["formula_version", "supplier", "reference"] as const;
export type MaterialChangeKind = (typeof MATERIAL_CHANGE_KINDS)[number];

const CONTINUITY_KEY = /^ck1:[0-9a-f]{64}$/;
const isKey = (v: unknown): v is string => typeof v === "string" && CONTINUITY_KEY.test(v);

export interface ProductContinuityCurrent {
  readonly productCode: string;
  readonly grade: string | null;
  readonly continuityKey: string;
  readonly effectiveFrom: string;
  readonly firstBatchNo: string | null;
}

export interface ProductMaterialChanged {
  readonly productCode: string;
  readonly grade: string | null;
  readonly kind: MaterialChangeKind;
  readonly fromKey: string;
  readonly toKey: string;
  readonly firstBatchNo: string | null;
  readonly approvedAt: string;
}

const CONTINUITY_KEYS = new Set(["product_code", "grade", "continuity_key", "effective_from", "first_batch_no"]);
const CHANGE_KEYS = new Set(["product_code", "grade", "kind", "from_key", "to_key", "first_batch_no", "approved_at"]);

function commonContinuityProblems(r: Record<string, unknown>, allowed: ReadonlySet<string>, problems: string[]): { productCode: string | null; grade: string | null; firstBatchNo: string | null } {
  const leak = formulaContentKey(r);
  if (leak) problems.push(`${leak} would carry formula content`);
  for (const k of Object.keys(r)) if (!allowed.has(k)) problems.push(`unexpected field ${k}`);
  const productCode = text(r.product_code, 80);
  if (!productCode) problems.push("product_code is required");
  const grade = r.grade === null || r.grade === undefined ? null : text(r.grade, 40);
  if (r.grade !== null && r.grade !== undefined && !grade) problems.push("grade must be text or null");
  const firstBatchNo = r.first_batch_no === null || r.first_batch_no === undefined ? null : text(r.first_batch_no, 64);
  if (r.first_batch_no !== null && r.first_batch_no !== undefined && !firstBatchNo) problems.push("first_batch_no must be a batch number or null");
  return { productCode, grade, firstBatchNo };
}

/** Structural validation of a `product.continuity.current` payload. Unknown keys are refused. */
export function parseProductContinuityCurrent(raw: unknown): { ok: true; record: ProductContinuityCurrent } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const c = commonContinuityProblems(r, CONTINUITY_KEYS, problems);
  if (!isKey(r.continuity_key)) problems.push("continuity_key must be ck1: and 64 hex characters");
  if (!ISO_INSTANT(r.effective_from)) problems.push("effective_from must be a timestamp");
  if (problems.length) return { ok: false, problems };
  return { ok: true, record: { productCode: c.productCode!, grade: c.grade, continuityKey: r.continuity_key as string, effectiveFrom: r.effective_from as string, firstBatchNo: c.firstBatchNo } };
}

/** Structural validation of a `product.material.changed` payload. Unknown keys are refused. */
export function parseProductMaterialChanged(raw: unknown): { ok: true; record: ProductMaterialChanged } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const c = commonContinuityProblems(r, CHANGE_KEYS, problems);
  if (!(MATERIAL_CHANGE_KINDS as readonly unknown[]).includes(r.kind)) problems.push(`kind must be one of ${MATERIAL_CHANGE_KINDS.join(", ")}`);
  if (!isKey(r.from_key)) problems.push("from_key must be ck1: and 64 hex characters");
  if (!isKey(r.to_key)) problems.push("to_key must be ck1: and 64 hex characters");
  if (isKey(r.from_key) && r.from_key === r.to_key) problems.push("a change moves from one key to another");
  if (!ISO_INSTANT(r.approved_at)) problems.push("approved_at must be a timestamp");
  if (problems.length) return { ok: false, problems };
  return { ok: true, record: { productCode: c.productCode!, grade: c.grade, kind: r.kind as MaterialChangeKind, fromKey: r.from_key as string, toKey: r.to_key as string, firstBatchNo: c.firstBatchNo, approvedAt: r.approved_at as string } };
}
