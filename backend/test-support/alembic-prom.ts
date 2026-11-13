/**
 * ALEMBIC's process-promise receiver rules, copied VERBATIM (test fixture only) from
 * alembic packages/domain/src/promises/facts.ts @ 02802897 (lane/prom; PROM-2, PROM-3). RawProd's promise tests run
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
