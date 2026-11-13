/**
 * ALEMBIC's process-promise receiver rules, copied VERBATIM (test fixture only) from
 * alembic packages/domain/src/promises/facts.ts (lane/prom; PROM-2, PROM-3, PROM-5, PROM-6). RawProd's promise tests run
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
  /* PROM-REVIEW: the factory counts the whole days between the two instants. More than that is a rest
     the record's own dates contradict, which the lot page would print and P-01 would count. */
  else if (ISO_INSTANT(r.started_at) && ISO_INSTANT(r.closed_at)
    && (r.days_rested as number) > Math.floor((Date.parse(r.closed_at) - Date.parse(r.started_at)) / (24 * 60 * 60 * 1000))) {
    problems.push("the days rested are more than the days between the rest's start and its close");
  }
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

/* ── PROM-6: the factory's rules, as the factory enforces them ──────────────────────────────
 *
 * `factory.rules.state` is how ALEMBIC learns that production ENFORCES a promise, not only that a
 * rule has a value (process-promises.md section 4: `enforced(rule)`). The factory sends it on every
 * change of one of these rules and once a day. Each rule carries its value, the policy version in
 * force (0 = the factory's registry default), and `enforcement_version`: a constant in the factory's
 * CODE, bumped by the commit that changed how the rule is enforced. A value alone does not prove the
 * code that enforces it is deployed; the two together do.
 *
 *   maceration.rest                          { version, enforcement_version, min_days, max_days, early_release }
 *   qc.reference_required                    { version, enforcement_version, value }
 *   fill.lot_server_assigned                 { version, enforcement_version, value }
 *   continuity.supplier_change_is_material   { version, enforcement_version, value }
 *   receiving.supplier_lot_required          { version, enforcement_version, value }   (PROM-1; absent until built)
 *
 * A rule the factory could not read (a malformed policy version: its gate holds every batch) is sent
 * as null. A rule key ALEMBIC does not know is IGNORED, so the factory can add one before ALEMBIC
 * reads it; a known rule of the wrong shape refuses the whole fact (permanent 400, RawProd parks it).
 * `branch` is null while the factory's rules have one general rung that every branch reads (LD-42:
 * one site); a branch code once WO-SET-2 scopes them. */

export const FACTORY_RULES_STATE = "factory.rules.state" as const;

export const FACTORY_RULE_KEYS = [
  "maceration.rest",
  "qc.reference_required",
  "fill.lot_server_assigned",
  "continuity.supplier_change_is_material",
  "receiving.supplier_lot_required",
] as const;
export type FactoryRuleKey = (typeof FACTORY_RULE_KEYS)[number];

/** The `enforcement_version` at which each rule's enforcement entered the factory's code. A state
 *  below it says the factory runs code that does not yet enforce the rule, so the promise cannot
 *  hold whatever the value says. The PROM unit that introduced each: */
export const FACTORY_RULE_INTRODUCED_AT: Readonly<Record<FactoryRuleKey, number>> = Object.freeze({
  "maceration.rest": 1, // PROM-2: every batch rests, no skip through HOLD/REWORK, early release by two people
  "qc.reference_required": 1, // PROM-3: QC 1 / QC 2 rounds against the retained reference are the release verdict
  "fill.lot_server_assigned": 1, // PROM-4: the lot is minted by the server at fill, a typed one refused
  "continuity.supplier_change_is_material": 1, // PROM-5: continuity recorded at compounding, a change sent before release
  "receiving.supplier_lot_required": 1, // PROM-1: supplier and supplier lot required at receipt
});

/** How old a rules state may be before no promise may rest on it (process-promises.md section 4). */
export const FACTORY_RULES_STATE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** PROM-REVIEW: how far ahead of the reader's clock a state may be dated and still count. Both systems
 *  run on one box today; five minutes covers a skewed clock, never a state from next week, whose
 *  negative age would otherwise pass the 48-hour test for as long as its future lasted. */
export const FACTORY_RULES_STATE_MAX_SKEW_MS = 5 * 60 * 1000;

export const FACTORY_RULES_STATE_REASONS = ["rule_change", "daily", "startup"] as const;

export interface RestRuleReading {
  readonly version: number;
  readonly enforcementVersion: number;
  readonly minDays: number;
  /** null = no maximum set (OQ-PROM-4); never an invented number. */
  readonly maxDays: number | null;
  readonly earlyRelease: "second_person";
}
export interface SwitchRuleReading {
  readonly version: number;
  readonly enforcementVersion: number;
  readonly value: boolean;
}
export type FactoryRuleReading = RestRuleReading | SwitchRuleReading;

export interface FactoryRulesState {
  readonly branch: string | null;
  readonly asOf: string;
  readonly reason: (typeof FACTORY_RULES_STATE_REASONS)[number];
  /** A key absent = the factory did not send that rule; null = it could not read it (its gate holds). */
  readonly rules: { readonly [K in FactoryRuleKey]?: (K extends "maceration.rest" ? RestRuleReading : SwitchRuleReading) | null };
  /** Rule keys sent that ALEMBIC does not know: ignored, kept only so the inbox shows them. */
  readonly ignoredKeys: readonly string[];
}

const STATE_KEYS = new Set(["branch", "as_of", "reason", "rules"]);
const isRuleKey = (k: string): k is FactoryRuleKey => (FACTORY_RULE_KEYS as readonly string[]).includes(k);

function readRule(key: FactoryRuleKey, raw: unknown, problems: string[]): FactoryRuleReading | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) { problems.push(`rules.${key} must be an object or null`); return null; }
  const o = raw as Record<string, unknown>;
  const allowed = key === "maceration.rest"
    ? ["version", "enforcement_version", "min_days", "max_days", "early_release"]
    : ["version", "enforcement_version", "value"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`unexpected field rules.${key}.${k}`);
  const bad = problems.length;
  if (!count(o.version)) problems.push(`rules.${key}.version must be a whole number (0 = the registry default)`);
  if (!count(o.enforcement_version, 1)) problems.push(`rules.${key}.enforcement_version must be a whole number from 1`);
  if (key === "maceration.rest") {
    if (!count(o.min_days, 1, 365)) problems.push("rules.maceration.rest.min_days must be 1 to 365");
    if (!(o.max_days === null || count(o.max_days, 1, 365))) problems.push("rules.maceration.rest.max_days must be 1 to 365 or null");
    if (count(o.min_days, 1, 365) && count(o.max_days, 1, 365) && (o.max_days as number) < (o.min_days as number)) problems.push("rules.maceration.rest.max_days cannot be less than min_days");
    if (o.early_release !== "second_person") problems.push("rules.maceration.rest.early_release must be second_person");
    if (problems.length > bad) return null;
    return { version: o.version as number, enforcementVersion: o.enforcement_version as number, minDays: o.min_days as number, maxDays: (o.max_days as number | null), earlyRelease: "second_person" };
  }
  if (typeof o.value !== "boolean") problems.push(`rules.${key}.value must be true or false`);
  if (problems.length > bad) return null;
  return { version: o.version as number, enforcementVersion: o.enforcement_version as number, value: o.value as boolean };
}

/** Structural validation of a `factory.rules.state` payload. Unknown top-level fields are refused
 *  (nothing else crosses, no person); unknown RULE keys are ignored. */
export function parseFactoryRulesState(raw: unknown): { ok: true; record: FactoryRulesState } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const leak = formulaContentKey(r);
  if (leak) problems.push(`${leak} would carry formula content`);
  for (const k of Object.keys(r)) if (!STATE_KEYS.has(k)) problems.push(`unexpected field ${k}`);
  const branch = r.branch === null ? null : text(r.branch, 40);
  if (r.branch !== null && !branch) problems.push("branch must be a branch code or null (the general rung)");
  if (!ISO_INSTANT(r.as_of)) problems.push("as_of must be a timestamp");
  if (!(FACTORY_RULES_STATE_REASONS as readonly unknown[]).includes(r.reason)) problems.push(`reason must be one of ${FACTORY_RULES_STATE_REASONS.join(", ")}`);
  const rules: Record<string, FactoryRuleReading | null> = {};
  const ignoredKeys: string[] = [];
  if (typeof r.rules !== "object" || r.rules === null || Array.isArray(r.rules)) problems.push("rules must be an object keyed by rule");
  else {
    for (const [k, v] of Object.entries(r.rules as Record<string, unknown>)) {
      if (!isRuleKey(k)) { if (k.length <= 80) ignoredKeys.push(k); continue; }
      rules[k] = readRule(k, v, problems);
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, record: { branch, asOf: r.as_of as string, reason: r.reason as FactoryRulesState["reason"], rules: rules as FactoryRulesState["rules"], ignoredKeys } };
}

/** Pure: whether the factory ENFORCES `key` according to `state`, at `now` (process-promises.md
 *  section 4, `enforced(rule)`). True only when the state is under 48 hours old, the rule was sent
 *  and readable, the factory's code is at or above the enforcement version that introduced it, and
 *  its value is the enforcing one. Every other answer is false with the reason, never a guess. */
export function factoryRuleEnforced(state: FactoryRulesState | null, key: FactoryRuleKey, now: Date): { enforced: boolean; reason: string } {
  if (!state) return { enforced: false, reason: "No factory rules state on file" };
  const age = now.getTime() - Date.parse(state.asOf);
  if (!(age <= FACTORY_RULES_STATE_MAX_AGE_MS)) return { enforced: false, reason: "The factory rules state is more than 48 hours old" };
  /* PROM-REVIEW: a state dated ahead of now has a negative age, which the line above lets through
     for as long as its future lasts, so a factory that went silent after one would keep every flag on. */
  if (age < -FACTORY_RULES_STATE_MAX_SKEW_MS) return { enforced: false, reason: "The factory rules state is dated in the future, so it proves nothing about now" };
  const rule = state.rules[key];
  if (rule === undefined) return { enforced: false, reason: `The factory did not send ${key}` };
  if (rule === null) return { enforced: false, reason: `The factory could not read ${key}, so it holds` };
  if (rule.enforcementVersion < FACTORY_RULE_INTRODUCED_AT[key]) return { enforced: false, reason: `The factory's code does not yet enforce ${key}` };
  if ("value" in rule && rule.value !== true) return { enforced: false, reason: `${key} is switched off` };
  return { enforced: true, reason: `${key} v${rule.version}, enforcement ${rule.enforcementVersion}` };
}

/* ── PROM-6: the promise block of `fg.batch.received` ────────────────────────────────────────
 *
 * A finished-good lot is filled from one compounded (oil) batch. The receipt carries that batch's
 * process record with it, so the lot itself holds what the storefront's per-lot promises rest on,
 * whether or not the batch's own facts were matched to it:
 *
 *   promise: { oil_batch_no, rest: <batch.rest.recorded> | null, qc: { stages, reference,
 *              is_reference_batch } | null, continuity_key: ck1:... | null, formula_version_ref: <opaque> | null }
 *
 * The label print stays where PROM-4 put it (`label_applied_at` beside the block). Every part may be
 * null (Rule 3: missing is null, the lot page says "Not on file"); a receipt with no block at all, from
 * an older sender, parses exactly as before. `formula_version_ref` is the factory's opaque version id,
 * never a formula's name or content (D-1). */

export interface FgPromiseBlock {
  readonly oilBatchNo: string;
  readonly rest: BatchRestRecord | null;
  readonly qc: QcPromiseBlock | null;
  readonly continuityKey: string | null;
  readonly formulaVersionRef: string | null;
}

const FG_PROMISE_KEYS = new Set(["oil_batch_no", "rest", "qc", "continuity_key", "formula_version_ref"]);

/** The `promise` block of an `fg.batch.received` payload; `block` is null when none was sent. */
export function parseFgPromiseBlock(raw: unknown): { ok: true; block: FgPromiseBlock | null } | { ok: false; problems: string[] } {
  if (raw === undefined || raw === null) return { ok: true, block: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["promise must be an object or null"] };
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const leak = formulaContentKey(r, "promise");
  if (leak) problems.push(`${leak} would carry formula content`);
  for (const k of Object.keys(r)) if (!FG_PROMISE_KEYS.has(k)) problems.push(`unexpected field promise.${k}`);
  const oilBatchNo = text(r.oil_batch_no, 64);
  if (!oilBatchNo) problems.push("promise.oil_batch_no is required: the compounded batch this lot was filled from");
  let rest: BatchRestRecord | null = null;
  if (r.rest !== undefined && r.rest !== null) {
    const p = parseBatchRestRecorded(r.rest);
    if (!p.ok) problems.push(...p.problems.map((x) => `promise.rest: ${x}`));
    else if (oilBatchNo && p.record.batchNo !== oilBatchNo) problems.push("promise.rest.batch_no must be promise.oil_batch_no");
    else rest = p.record;
  }
  let qc: QcPromiseBlock | null = null;
  if (r.qc !== undefined && r.qc !== null) {
    if (typeof r.qc !== "object" || Array.isArray(r.qc)) problems.push("promise.qc must be an object or null");
    else {
      const o = r.qc as Record<string, unknown>;
      for (const k of Object.keys(o)) if (!["stages", "reference", "is_reference_batch"].includes(k)) problems.push(`unexpected field promise.qc.${k}`);
      const p = parseQcPromiseBlock(o);
      if (!p.ok) problems.push(...p.problems.map((x) => `promise.qc: ${x}`));
      else qc = p.block;
    }
  }
  const continuityKey = r.continuity_key === undefined || r.continuity_key === null ? null : r.continuity_key;
  if (continuityKey !== null && !isKey(continuityKey)) problems.push("promise.continuity_key must be ck1: and 64 hex characters, or null");
  const formulaVersionRef = r.formula_version_ref === undefined || r.formula_version_ref === null ? null : text(r.formula_version_ref, 64);
  if (r.formula_version_ref !== undefined && r.formula_version_ref !== null && !formulaVersionRef) problems.push("promise.formula_version_ref must be an opaque reference or null");
  if (problems.length) return { ok: false, problems };
  return { ok: true, block: { oilBatchNo: oilBatchNo!, rest, qc, continuityKey: continuityKey as string | null, formulaVersionRef } };
}

/* ── PROM-6: a rest that has begun ──────────────────────────────────────────────────────────
 *
 * `batch.rest.recorded` arrives only when a rest ends. Order tracking's "Resting (maceration)" step
 * (P-10) needs the rest's real dates WHILE it runs, so the factory also sends `batch.rest.started`
 * when a maceration run opens, and again on each extension (the latest per run is the schedule).
 * `release_due_at` is the earliest the batch may be released without a second person: started_at
 * plus required_days. Never a promise of a release date: QC 2 still decides. */

export const BATCH_REST_STARTED = "batch.rest.started" as const;

export interface BatchRestStarted {
  readonly batchNo: string;
  readonly oilBatchRef: string;
  readonly startedAt: string;
  readonly requiredDays: number;
  readonly ruleDays: number;
  readonly ruleVersion: number;
  readonly releaseDueAt: string;
}

const REST_START_KEYS = new Set(["batch_no", "oil_batch_ref", "started_at", "required_days", "rule_days", "rule_version", "release_due_at"]);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Structural validation of a `batch.rest.started` payload. Unknown keys are refused. */
export function parseBatchRestStarted(raw: unknown): { ok: true; record: BatchRestStarted } | { ok: false; problems: string[] } {
  const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const leak = formulaContentKey(r);
  if (leak) problems.push(`${leak} would carry formula content`);
  for (const k of Object.keys(r)) if (!REST_START_KEYS.has(k)) problems.push(`unexpected field ${k}`);
  const batchNo = text(r.batch_no, 64);
  if (!batchNo) problems.push("batch_no is required");
  const oilBatchRef = text(r.oil_batch_ref, 64);
  if (!oilBatchRef) problems.push("oil_batch_ref is required");
  if (!ISO_INSTANT(r.started_at)) problems.push("started_at must be a timestamp");
  if (!count(r.required_days, 1, 365)) problems.push("required_days must be 1 to 365");
  if (!count(r.rule_days, 1, 365)) problems.push("rule_days must be 1 to 365");
  if (count(r.required_days, 1, 365) && count(r.rule_days, 1, 365) && r.required_days < r.rule_days) problems.push("required_days cannot be shorter than the branch rule: a shorter rest is an early release");
  if (!count(r.rule_version)) problems.push("rule_version must be a whole number");
  if (!ISO_INSTANT(r.release_due_at)) problems.push("release_due_at must be a timestamp");
  else if (ISO_INSTANT(r.started_at) && count(r.required_days, 1, 365)
    && Math.abs(Date.parse(r.release_due_at) - (Date.parse(r.started_at) + (r.required_days as number) * DAY_MS)) > 60_000) {
    problems.push("release_due_at must be started_at plus required_days");
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, record: { batchNo: batchNo!, oilBatchRef: oilBatchRef!, startedAt: r.started_at as string, requiredDays: r.required_days as number,
    ruleDays: r.rule_days as number, ruleVersion: r.rule_version as number, releaseDueAt: r.release_due_at as string } };
}
