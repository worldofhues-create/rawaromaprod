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
