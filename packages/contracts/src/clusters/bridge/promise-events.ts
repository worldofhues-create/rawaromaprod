/**
 * The process-promise facts (LD-85, ALEMBIC docs/plan/program/process-promises.md), RawProd's side.
 * Pure: no I/O, no NestJS. The storefront prints "Every batch rests 45 days between QC 1 and QC 2"
 * only when production enforces it AND every lot on sale carries the record that proves it; these
 * are the records.
 *
 *   PROM-2  `batch.rest.recorded`  sent once, when a maceration run closes on release. Aggregate
 *           `maceration_run`, id = the run's uuid. The lot page reads "Rested 45 days, 14 Sep to
 *           29 Oct 2026" from it, and "Rest record: Not on file" where none arrived.
 *
 *   PROM-3  `qc.batch.released` gains `stages` (each QC 1 / QC 2 round: its stage, opaque round
 *           ref, when it was decided, the decision), `reference` (the retained reference the last
 *           QC 2 compared with: its code, the retained bottle's sample code and date) or null, and
 *           `is_reference_batch` (this batch IS a product's approved retained reference). Optional:
 *           an older RawProd that sends none of them still parses on ALEMBIC's side.
 *
 * `checkBatchRestRecordedWire` applies ALEMBIC's own parse rules (`parseBatchRestRecorded`,
 * packages/domain/src/promises/facts.ts on that side) before the row is written to the outbox, so a
 * payload ALEMBIC would refuse is refused here instead of parking there.
 *
 * D-1 / VAULT.md rule 1: no material name, supplier, formula id or percentage. The batch number and
 * an opaque run reference are the only identities; every emitter still runs `assertNoFormulaContent`.
 */

export const BATCH_REST_RECORDED = "batch.rest.recorded" as const;
/** Envelope `aggregate.type` for `batch.rest.recorded`; `aggregate.id` = production.maceration_run id. */
export const BATCH_REST_AGGREGATE_TYPE = "maceration_run" as const;

/** The R and 2P reason codes (system-led-operations.md 3.3). `quality_doubt` is a toward-caution
 *  code and is not allowed for an early release, which is away from caution. */
export const AWAY_FROM_CAUTION_REASON_CODES = [
  "customer_commitment",
  "confirmed_outside_system",
  "system_data_wrong",
  "supplier_or_carrier_constraint",
  "instructed_by_manager",
  "other",
] as const;
export type AwayFromCautionReasonCode = (typeof AWAY_FROM_CAUTION_REASON_CODES)[number];

export interface BatchRestTemperatureWire {
  /** Opaque zone reference, never a zone's name. */
  readonly zone_ref: string;
  readonly readings_expected: number;
  readonly readings_on_file: number;
}

export interface BatchRestRecordedWire {
  /** The compounded batch number (== `qc.batch.released.batch_no`, == ALEMBIC `lot.qc_batch_no`). */
  readonly batch_no: string;
  /** Opaque: RawProd's oil-batch uuid. */
  readonly oil_batch_ref: string;
  /** When the rest started (QC 1 passed, the batch went into maceration). ISO 8601 UTC. */
  readonly started_at: string;
  /** When the run closed (QC 2 passed, the batch released). ISO 8601 UTC, after `started_at`. */
  readonly closed_at: string;
  /** Whole days between the two. */
  readonly days_rested: number;
  /** What this batch had to rest: the branch rule, a formula's longer rest, plus any extension. */
  readonly required_days: number;
  /** The branch rule `maceration.rest` in force when the rest started: its minimum and version
   *  (0 = the registry default, before any version was published). */
  readonly rule_days: number;
  readonly rule_version: number;
  /** true only when a second person approved releasing before `required_days`. */
  readonly early_release: boolean;
  /** The 2P reason code of that early release, else null. Never the free text (it may name people). */
  readonly early_release_reason_code: AwayFromCautionReasonCode | null;
  /** Temperature during the rest, or null when no zone log covers the batch (the lot page then says
   *  "Temperature log: Not on file"; it never infers one). */
  readonly temperature: BatchRestTemperatureWire | null;
}

const isNonEmpty = (v: unknown, max = 200) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isIsoInstant = (v: unknown) => typeof v === "string" && v.includes("T") && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown, min = 0) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= 100_000;

/** ALEMBIC's `parseBatchRestRecorded` rules ([] = accepted). Exactly the fields above. */
export function checkBatchRestRecordedWire(p: BatchRestRecordedWire): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.batch_no, 64)) out.push("batch_no");
  if (!isNonEmpty(p.oil_batch_ref, 64)) out.push("oil_batch_ref");
  if (!isIsoInstant(p.started_at)) out.push("started_at");
  if (!isIsoInstant(p.closed_at) || (isIsoInstant(p.started_at) && Date.parse(p.closed_at) < Date.parse(p.started_at))) out.push("closed_at");
  if (!isCount(p.days_rested)) out.push("days_rested");
  if (!isCount(p.required_days, 1) || p.required_days > 365) out.push("required_days");
  if (!isCount(p.rule_days, 1) || p.rule_days > 365) out.push("rule_days");
  if (!isCount(p.rule_version)) out.push("rule_version");
  if (typeof p.early_release !== "boolean") out.push("early_release");
  const code = p.early_release_reason_code;
  if (p.early_release) {
    if (!(AWAY_FROM_CAUTION_REASON_CODES as readonly string[]).includes(String(code))) out.push("early_release_reason_code");
  } else if (code !== null) out.push("early_release_reason_code");
  // A rest shorter than required is an early release, and nothing else is.
  if (typeof p.early_release === "boolean" && isCount(p.days_rested) && isCount(p.required_days, 1)
      && !p.early_release && p.days_rested < p.required_days) out.push("days_rested.short_without_early_release");
  const t = p.temperature;
  if (t !== null) {
    if (typeof t !== "object" || !isNonEmpty(t.zone_ref, 64) || !isCount(t.readings_expected) || !isCount(t.readings_on_file)
        || t.readings_on_file > t.readings_expected) out.push("temperature");
  }
  const allowed = new Set(["batch_no", "oil_batch_ref", "started_at", "closed_at", "days_rested", "required_days", "rule_days",
    "rule_version", "early_release", "early_release_reason_code", "temperature"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) out.push(`unexpected:${k}`);
  return out;
}

/* ── PROM-3: the QC stages and the retained reference on `qc.batch.released` ──────────────────── */

export const QC_STAGES = ["QC1", "QC2"] as const;
export type QcStageCode = (typeof QC_STAGES)[number];
export const QC_ROUND_DECISIONS = ["APPROVE", "REWORK", "HOLD_RETEST", "REJECT", "REVIEW", "HOLD_CAPA"] as const;

export interface QcStageWire {
  readonly stage: QcStageCode;
  /** Opaque: RawProd's batch_qc_round uuid. */
  readonly round_ref: string;
  readonly decided_at: string;
  readonly decision: (typeof QC_ROUND_DECISIONS)[number];
}

export interface QcReferenceWire {
  /** The reference's code, "R-<product code>-<n>". */
  readonly ref: string;
  /** The retained bottle's sample code, as QC scanned it at the comparison. */
  readonly sample_code: string;
  /** When that sample was retained (ISO 8601 UTC), or null when the retention record has no date. */
  readonly retained_at: string | null;
}

export interface QcPromiseBlockWire {
  readonly stages: readonly QcStageWire[];
  readonly reference: QcReferenceWire | null;
  readonly is_reference_batch: boolean;
}

/** ALEMBIC's rules for the PROM-3 block ([] = accepted). Fields absent = an older sender; accepted. */
export function checkQcPromiseBlockWire(p: Partial<QcPromiseBlockWire>): string[] {
  const out: string[] = [];
  if (p.stages !== undefined) {
    if (!Array.isArray(p.stages) || p.stages.length > 50) out.push("stages");
    else p.stages.forEach((st, i) => {
      if (!st || !(QC_STAGES as readonly string[]).includes(st.stage) || !isNonEmpty(st.round_ref, 64) || !isIsoInstant(st.decided_at)
          || !(QC_ROUND_DECISIONS as readonly string[]).includes(st.decision)) out.push(`stages[${i}]`);
    });
  }
  if (p.reference !== undefined && p.reference !== null) {
    const r = p.reference;
    if (!isNonEmpty(r.ref, 80) || !isNonEmpty(r.sample_code, 50) || !(r.retained_at === null || isIsoInstant(r.retained_at))) out.push("reference");
  }
  if (p.is_reference_batch !== undefined && typeof p.is_reference_batch !== "boolean") out.push("is_reference_batch");
  return out;
}

/* ── PROM-3: a batch becomes its product's retained reference ─────────────────────────────────
 *
 * `qc.reference.established` is sent once, in the transaction where a second person approves a
 * batch's retained sample as its product's reference. A reference is proposed only from a batch that
 * passed QC 2, so that batch's own `qc.batch.released` has usually gone out already, saying
 * `is_reference_batch: false`; this fact is what lets its lot page say "This batch is the retained
 * reference for this code and grade". It never claims a comparison. Aggregate `reference_standard`,
 * id = quality.reference_standard id. No person, product name or material crosses. */

export const QC_REFERENCE_ESTABLISHED = "qc.reference.established" as const;
export const QC_REFERENCE_AGGREGATE_TYPE = "reference_standard" as const;

export interface QcReferenceEstablishedWire {
  /** The batch whose retained sample is the reference (== its `qc.batch.released.batch_no`). */
  readonly batch_no: string;
  /** Opaque: RawProd's oil-batch uuid. */
  readonly oil_batch_ref: string;
  /** The reference: its code, the retained bottle's sample code, when the sample was retained. */
  readonly reference: QcReferenceWire;
  /** When the second person approved it (ISO 8601 UTC). */
  readonly established_at: string;
  /** The reference this one retired, or null. */
  readonly replaces_ref: string | null;
}

/** ALEMBIC's `parseQcReferenceEstablished` rules ([] = accepted). Exactly the fields above. */
export function checkQcReferenceEstablishedWire(p: QcReferenceEstablishedWire): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.batch_no, 64)) out.push("batch_no");
  if (!isNonEmpty(p.oil_batch_ref, 64)) out.push("oil_batch_ref");
  if (!isIsoInstant(p.established_at)) out.push("established_at");
  const r = p.reference;
  if (!r || typeof r !== "object" || !isNonEmpty(r.ref, 80) || !isNonEmpty(r.sample_code, 50) || !(r.retained_at === null || isIsoInstant(r.retained_at))) out.push("reference");
  else for (const k of Object.keys(r)) if (!["ref", "sample_code", "retained_at"].includes(k)) out.push(`unexpected:reference.${k}`);
  if (!(p.replaces_ref === null || isNonEmpty(p.replaces_ref, 80))) out.push("replaces_ref");
  if (p.replaces_ref !== null && r && p.replaces_ref === r.ref) out.push("replaces_ref.self");
  const allowed = new Set(["batch_no", "oil_batch_ref", "reference", "established_at", "replaces_ref"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) out.push(`unexpected:${k}`);
  return out;
}

/* ── PROM-5: continuity, and a change of material ─────────────────────────────────────────────
 *
 * `product.continuity.current` is sent whenever a product's continuity key changes: its first keyed
 * batch, a batch whose formula version, raw-material suppliers or reference differ, or a new reference.
 * `product.material.changed` is sent once per kind of change, before any lot made under the new key can
 * be released (it is recorded at compounding, and every batch then rests). The key is opaque
 * (ck1:sha256): no material, supplier, formula or percentage can be read from it. Aggregates
 * `product_continuity` / `material_change`, ids = RawProd's row uuids. `grade` is null: a RawProd
 * product row IS one code and grade, so the code carries it. No person crosses. */

export const PRODUCT_CONTINUITY_CURRENT = "product.continuity.current" as const;
export const PRODUCT_CONTINUITY_AGGREGATE_TYPE = "product_continuity" as const;
export const PRODUCT_MATERIAL_CHANGED = "product.material.changed" as const;
export const MATERIAL_CHANGE_AGGREGATE_TYPE = "material_change" as const;
export const MATERIAL_CHANGE_KINDS = ["formula_version", "supplier", "reference"] as const;
export type MaterialChangeKindWire = (typeof MATERIAL_CHANGE_KINDS)[number];

const isContinuityKey = (v: unknown) => typeof v === "string" && /^ck1:[0-9a-f]{64}$/.test(v);

export interface ProductContinuityCurrentWire {
  readonly product_code: string;
  readonly grade: string | null;
  readonly continuity_key: string;
  readonly effective_from: string;
  /** The first batch made under this key, or null when a new reference moved it. */
  readonly first_batch_no: string | null;
}

export interface ProductMaterialChangedWire {
  readonly product_code: string;
  readonly grade: string | null;
  readonly kind: MaterialChangeKindWire;
  readonly from_key: string;
  readonly to_key: string;
  readonly first_batch_no: string | null;
  readonly approved_at: string;
}

/** ALEMBIC's `parseProductContinuityCurrent` rules ([] = accepted). Exactly the fields above. */
export function checkProductContinuityCurrentWire(p: ProductContinuityCurrentWire): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.product_code, 80)) out.push("product_code");
  if (!(p.grade === null || isNonEmpty(p.grade, 40))) out.push("grade");
  if (!isContinuityKey(p.continuity_key)) out.push("continuity_key");
  if (!isIsoInstant(p.effective_from)) out.push("effective_from");
  if (!(p.first_batch_no === null || isNonEmpty(p.first_batch_no, 64))) out.push("first_batch_no");
  const allowed = new Set(["product_code", "grade", "continuity_key", "effective_from", "first_batch_no"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) out.push(`unexpected:${k}`);
  return out;
}

/** ALEMBIC's `parseProductMaterialChanged` rules ([] = accepted). Exactly the fields above. */
export function checkProductMaterialChangedWire(p: ProductMaterialChangedWire): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.product_code, 80)) out.push("product_code");
  if (!(p.grade === null || isNonEmpty(p.grade, 40))) out.push("grade");
  if (!(MATERIAL_CHANGE_KINDS as readonly string[]).includes(p.kind)) out.push("kind");
  if (!isContinuityKey(p.from_key)) out.push("from_key");
  if (!isContinuityKey(p.to_key)) out.push("to_key");
  if (isContinuityKey(p.from_key) && p.from_key === p.to_key) out.push("to_key.same");
  if (!(p.first_batch_no === null || isNonEmpty(p.first_batch_no, 64))) out.push("first_batch_no");
  if (!isIsoInstant(p.approved_at)) out.push("approved_at");
  const allowed = new Set(["product_code", "grade", "kind", "from_key", "to_key", "first_batch_no", "approved_at"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) out.push(`unexpected:${k}`);
  return out;
}

/* ── PROM-6: the factory's rules as it enforces them, a rest begun, and the lot's promise block ─────
 *
 * `factory.rules.state`  each process-promise rule with its policy version (0 = the registry default)
 *                        and the CODE's enforcement version (backend-kernel FACTORY_ENFORCEMENT_VERSION),
 *                        sent on every change of one of them, once a day and once at start. ALEMBIC
 *                        prints a promise only while the rule is enforced: a value alone does not prove the
 *                        enforcing code is deployed, the two together do. Aggregate `factory_rules`. A rule
 *                        the factory could not read (its gate holds every batch) is null. `branch` is null:
 *                        the general rung every branch reads until WO-SET-2 scopes the rules (LD-42).
 * `batch.rest.started`   a maceration run opened or was extended: the rest's schedule while it runs, for
 *                        order tracking's "Resting" step. Aggregate `maceration_run`.
 * `fg.batch.received`    gains an optional `promise` block: the compounded batch the lot was filled from,
 *                        its rest, its QC rounds and reference, its continuity key and its opaque formula
 *                        version id. Never a material, supplier, formula name or percentage (D-1). */

export const FACTORY_RULES_STATE = "factory.rules.state" as const;
export const FACTORY_RULES_AGGREGATE_TYPE = "factory_rules" as const;
export const FACTORY_RULES_STATE_REASONS = ["rule_change", "daily", "startup"] as const;
export type FactoryRulesStateReason = (typeof FACTORY_RULES_STATE_REASONS)[number];

export interface RestRuleReadingWire {
  readonly version: number;
  readonly enforcement_version: number;
  readonly min_days: number;
  readonly max_days: number | null;
  readonly early_release: "second_person";
}
export interface SwitchRuleReadingWire {
  readonly version: number;
  readonly enforcement_version: number;
  readonly value: boolean;
}
export interface FactoryRulesStateWire {
  readonly branch: string | null;
  readonly as_of: string;
  readonly reason: FactoryRulesStateReason;
  readonly rules: {
    readonly "maceration.rest"?: RestRuleReadingWire | null;
    readonly "qc.reference_required"?: SwitchRuleReadingWire | null;
    readonly "fill.lot_server_assigned"?: SwitchRuleReadingWire | null;
    readonly "continuity.supplier_change_is_material"?: SwitchRuleReadingWire | null;
    readonly "receiving.supplier_lot_required"?: SwitchRuleReadingWire | null;
  };
}

/** ALEMBIC's `parseFactoryRulesState` rules for what this side sends ([] = accepted). Stricter than the
 *  receiver on one point: this side never sends a rule key the receiver does not know. */
export function checkFactoryRulesStateWire(p: FactoryRulesStateWire): string[] {
  const out: string[] = [];
  if (!(p.branch === null || isNonEmpty(p.branch, 40))) out.push("branch");
  if (!isIsoInstant(p.as_of)) out.push("as_of");
  if (!(FACTORY_RULES_STATE_REASONS as readonly string[]).includes(p.reason)) out.push("reason");
  const rules = (p.rules ?? null) as Record<string, unknown> | null;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) out.push("rules");
  else for (const [k, v] of Object.entries(rules)) {
    if (!["maceration.rest", "qc.reference_required", "fill.lot_server_assigned", "continuity.supplier_change_is_material", "receiving.supplier_lot_required"].includes(k)) { out.push(`unexpected:rules.${k}`); continue; }
    if (v === null) continue;
    const o = v as Record<string, unknown>;
    if (!isCount(o.version)) out.push(`rules.${k}.version`);
    if (!isCount(o.enforcement_version, 1)) out.push(`rules.${k}.enforcement_version`);
    const allowed = k === "maceration.rest" ? ["version", "enforcement_version", "min_days", "max_days", "early_release"] : ["version", "enforcement_version", "value"];
    for (const f of Object.keys(o)) if (!allowed.includes(f)) out.push(`unexpected:rules.${k}.${f}`);
    if (k === "maceration.rest") {
      const min = o.min_days, max = o.max_days;
      if (!isCount(min, 1) || (min as number) > 365) out.push("rules.maceration.rest.min_days");
      if (!(max === null || (isCount(max, 1) && (max as number) <= 365))) out.push("rules.maceration.rest.max_days");
      if (isCount(min, 1) && isCount(max, 1) && (max as number) < (min as number)) out.push("rules.maceration.rest.max_days.below_min");
      if (o.early_release !== "second_person") out.push("rules.maceration.rest.early_release");
    } else if (typeof o.value !== "boolean") out.push(`rules.${k}.value`);
  }
  for (const k of Object.keys(p)) if (!["branch", "as_of", "reason", "rules"].includes(k)) out.push(`unexpected:${k}`);
  return out;
}

export const BATCH_REST_STARTED = "batch.rest.started" as const;

export interface BatchRestStartedWire {
  readonly batch_no: string;
  /** Opaque: RawProd's oil-batch uuid. */
  readonly oil_batch_ref: string;
  readonly started_at: string;
  /** What this batch must rest: the branch rule, a formula's longer rest, plus any extension. */
  readonly required_days: number;
  readonly rule_days: number;
  readonly rule_version: number;
  /** started_at + required_days: the earliest release without a second person. Never a promised date. */
  readonly release_due_at: string;
}

/** ALEMBIC's `parseBatchRestStarted` rules ([] = accepted). Exactly the fields above. */
export function checkBatchRestStartedWire(p: BatchRestStartedWire): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.batch_no, 64)) out.push("batch_no");
  if (!isNonEmpty(p.oil_batch_ref, 64)) out.push("oil_batch_ref");
  if (!isIsoInstant(p.started_at)) out.push("started_at");
  if (!isCount(p.required_days, 1) || p.required_days > 365) out.push("required_days");
  if (!isCount(p.rule_days, 1) || p.rule_days > 365) out.push("rule_days");
  if (isCount(p.required_days, 1) && isCount(p.rule_days, 1) && p.required_days < p.rule_days) out.push("required_days.below_rule");
  if (!isCount(p.rule_version)) out.push("rule_version");
  if (!isIsoInstant(p.release_due_at)) out.push("release_due_at");
  else if (isIsoInstant(p.started_at) && isCount(p.required_days, 1)
    && Math.abs(Date.parse(p.release_due_at) - (Date.parse(p.started_at) + p.required_days * 86_400_000)) > 60_000) out.push("release_due_at.not_started_plus_required");
  const allowed = new Set(["batch_no", "oil_batch_ref", "started_at", "required_days", "rule_days", "rule_version", "release_due_at"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) out.push(`unexpected:${k}`);
  return out;
}

export interface FgPromiseBlockWire {
  /** The compounded batch the lot was filled from (== `qc_batch_no`). */
  readonly oil_batch_no: string;
  readonly rest: BatchRestRecordedWire | null;
  readonly qc: QcPromiseBlockWire | null;
  readonly continuity_key: string | null;
  /** Opaque: RawProd's formula version uuid; never a name or content. */
  readonly formula_version_ref: string | null;
}

/** ALEMBIC's `parseFgPromiseBlock` rules ([] = accepted). */
export function checkFgPromiseBlockWire(p: FgPromiseBlockWire, qcBatchNo?: string | null): string[] {
  const out: string[] = [];
  if (!isNonEmpty(p.oil_batch_no, 64)) out.push("promise.oil_batch_no");
  if (qcBatchNo && p.oil_batch_no !== qcBatchNo) out.push("promise.oil_batch_no.not_qc_batch_no");
  if (p.rest !== null) {
    checkBatchRestRecordedWire(p.rest).forEach((x) => out.push(`promise.rest.${x}`));
    if (p.rest.batch_no !== p.oil_batch_no) out.push("promise.rest.batch_no");
  }
  if (p.qc !== null) {
    checkQcPromiseBlockWire(p.qc).forEach((x) => out.push(`promise.qc.${x}`));
    for (const k of Object.keys(p.qc)) if (!["stages", "reference", "is_reference_batch"].includes(k)) out.push(`unexpected:promise.qc.${k}`);
  }
  if (!(p.continuity_key === null || isContinuityKey(p.continuity_key))) out.push("promise.continuity_key");
  if (!(p.formula_version_ref === null || isNonEmpty(p.formula_version_ref, 64))) out.push("promise.formula_version_ref");
  for (const k of Object.keys(p)) if (!["oil_batch_no", "rest", "qc", "continuity_key", "formula_version_ref"].includes(k)) out.push(`unexpected:promise.${k}`);
  return out;
}
