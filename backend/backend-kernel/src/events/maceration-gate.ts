/**
 * Maceration gate (lane pf-c, production-floor plan section 8) — shared by the clusters that move
 * a batch (production), ship it (sales), reserve it or move it as finished goods (packaging, shelf).
 * Lives in the kernel beside bridge-emit for the same reason: several clusters call it inside their
 * own transaction, and none may import another.
 *
 * PROM-2 (LD-85: "Every batch rests 45 days between QC 1 and QC 2", owner: "it has to be true"):
 *   - EVERY batch rests. The days come from the branch rule `maceration.rest` (factory-rules.ts,
 *     default 45); a formula's own maceration_setting may only LENGTHEN it (and adds its freeze
 *     step). Before PROM-2 a formula without a setting skipped maceration altogether.
 *   - RELEASED with no open run is refused: HOLD -> RELEASED and REWORK -> RELEASED used to release a
 *     batch that never rested on a single QC PASS. The edges stay in OIL_TRANSITIONS; this refuses them.
 *   - An early release is two people: requested with a reason code and text, approved by someone
 *     else (floor-ops/maceration.service.ts). QC 2 still gates.
 *   - On close the run records the days rested and `batch.rest.recorded` goes to ALEMBIC in the
 *     same transaction: the record the lot page shows a customer.
 *
 * PROM-3 (LD-85: "checked against a retained reference before it ships"): with the factory rule
 *   `qc.reference_required` on (v1, the default), QC 1 and QC 2 are ROUNDS on the product's pinned
 *   checkpoints (quality.batch_qc_round, stage QC1 / QC2), each compared with the product's retained
 *   reference (or recorded as NO_REFERENCE_YET for a product that has none). A typed production_qc
 *   PASS no longer moves a batch into maceration or releases it. QC 2 counts only when taken after the
 *   rest ended, and only with a retained sample of this batch on file.
 *
 * Flow:
 *   Mixer -> QC 1 PASS -> IN_MATURATION (a run opens, the timer starts) -> freeze/chill-filter step
 *   (when required) -> required days reached (or a second person's early release) -> QC 2 PASS
 *   recorded after the run started -> RELEASED (the run closes, the fact is sent).
 *   REWORK -> IN_MATURATION restarts the timer. FAILED cancels the run.
 *
 * While a run is open the batch cannot ship, become/move as finished goods, or be reserved: the
 * system refuses, it does not warn.
 */
import { ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { bridge as bridgeContracts } from '@core/contracts';
import { emitBridgeManualEvent, type BridgeEmitTx } from './bridge-emit.js';
import { referenceRuleInForce, restRuleInForce } from './factory-rules.js';

const DAY_MS = 86_400_000;

interface RunRow {
  maceration_run_id: string;
  oil_batch_id: string;
  batch_number: string | null;
  started_at: string | Date;
  min_days: number;
  /** null = no maximum (the branch rule sets none and no formula setting applies). */
  max_days: number | null;
  extend_days: number;
  freeze_required: boolean;
  freeze_done_at: string | Date | null;
  early_release_at: string | Date | null;
  early_release_reason_code: string | null;
  rule_days: number | null;
  rule_version: number | null;
}

const ts = (v: string | Date) => (v instanceof Date ? v : new Date(String(v).replace(' ', 'T'))).getTime();
async function rows<T>(tx: BridgeEmitTx, q: unknown): Promise<T[]> {
  return Array.from((await tx.execute(q)) as unknown as T[]);
}

/** Day N (1-based) of the run, and whether its minimum time has passed. */
export function macerationProgress(run: { started_at: string | Date; min_days: number; extend_days: number; max_days: number | null; early_release_at?: string | Date | null }, now: Date) {
  const elapsedMs = Math.max(0, now.getTime() - ts(run.started_at));
  const day = Math.floor(elapsedMs / DAY_MS) + 1;
  const needDays = Number(run.min_days) + Number(run.extend_days ?? 0);
  const minReached = elapsedMs >= needDays * DAY_MS;
  // PROM-2: no maximum set means no over-maximum alarm, never an invented number.
  const maxDays = run.max_days == null ? null : Number(run.max_days);
  return { day, needDays, maxDays, minReached, overMax: maxDays !== null && elapsedMs > maxDays * DAY_MS, releasedEarly: !!run.early_release_at, daysRested: Math.floor(elapsedMs / DAY_MS) };
}

interface RoundRow {
  batch_qc_round_id: string;
  stage: string | null;
  decision: string;
  /** epoch ms, read as a number so no driver's timestamp parsing is involved */
  created_ms: number;
  reference_basis: string | null;
}

/** The latest QC round on the batch (PROM-3: the verdict when qc.reference_required is on). */
async function latestRound(tx: BridgeEmitTx, oilBatchId: string): Promise<RoundRow | undefined> {
  return (await rows<RoundRow>(tx, sql`
    select batch_qc_round_id, stage, decision, (extract(epoch from created_dt) * 1000)::float8 as created_ms, reference_basis from quality.batch_qc_round
     where oil_batch_id = ${oilBatchId} order by round_no desc limit 1`))[0];
}

/** When the rest of an open run ended: the required days served, or a second person's early release. */
export function restEndedAt(run: { started_at: string | Date; min_days: number; extend_days: number; early_release_at?: string | Date | null }, now: Date): Date | null {
  const served = ts(run.started_at) + (Number(run.min_days) + Number(run.extend_days ?? 0)) * DAY_MS;
  if (served <= now.getTime()) return new Date(served);
  return run.early_release_at ? new Date(ts(run.early_release_at)) : null;
}

async function openRun(tx: BridgeEmitTx, oilBatchId: string): Promise<RunRow | undefined> {
  return (await rows<RunRow>(tx, sql`
    select mr.*, ob.batch_number from production.maceration_run mr
      left join production.oil_batch_master ob on ob.oil_batch_id = mr.oil_batch_id
     where mr.oil_batch_id = ${oilBatchId} and mr.status = 'MACERATING' for update of mr`))[0];
}

async function event(tx: BridgeEmitTx, runId: string, ev: string, note: string | null, userId: string | null) {
  await tx.execute(sql`
    insert into production.maceration_event (maceration_event_id, maceration_run_id, event, note, performed_by)
    values (${randomUUID()}, ${runId}, ${ev}, ${note}, ${userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null})`);
}

/**
 * Throws when the oil batch (or the oil batch behind a finished-good batch) is macerating.
 * `action` finishes the sentence "it cannot …".
 */
export async function assertNotMacerating(
  tx: BridgeEmitTx,
  ref: { oilBatchId?: string | null; finishedGoodBatchId?: string | null },
  action: string,
  now: Date = new Date(),
): Promise<void> {
  let oilBatchId = ref.oilBatchId ?? null;
  if (!oilBatchId && ref.finishedGoodBatchId) {
    const r = await rows<{ oil_batch_id: string | null }>(tx, sql`
      select po.oil_batch_id from packaging.finished_good_batch_master fg
        join packaging.package_order po on po.package_order_id = fg.package_order_id
       where fg.finished_good_batch_id = ${ref.finishedGoodBatchId}`);
    oilBatchId = r[0]?.oil_batch_id ?? null;
  }
  if (!oilBatchId) return;
  const run = (await rows<RunRow>(tx, sql`
    select mr.*, ob.batch_number from production.maceration_run mr
      left join production.oil_batch_master ob on ob.oil_batch_id = mr.oil_batch_id
     where mr.oil_batch_id = ${oilBatchId} and mr.status = 'MACERATING'`))[0];
  if (!run) return;
  const p = macerationProgress(run, now);
  throw new ConflictException(
    `Batch ${run.batch_number ?? oilBatchId} is macerating (day ${p.day} of ${p.needDays}). It cannot ${action} until maceration ends and QC 2 passes.`,
  );
}

/** Closes the run and sends `batch.rest.recorded` in the same transaction (PROM-2). */
async function closeRun(tx: BridgeEmitTx, run: RunRow, p: ReturnType<typeof macerationProgress>, now: Date, userId: string | null) {
  const earlyRelease = !p.minReached && p.releasedEarly;
  await tx.execute(sql`
    update production.maceration_run set status = 'CLOSED', closed_at = ${now.toISOString()}::timestamptz, days_rested = ${p.daysRested},
           rest_short = ${earlyRelease}, updated_at = ${now.toISOString()}::timestamptz
     where maceration_run_id = ${run.maceration_run_id}`);
  await event(tx, run.maceration_run_id, 'CLOSED', `QC 2 passed; released after ${p.daysRested} of ${p.needDays} days${earlyRelease ? ' (early release, approved by a second person)' : ''}`, userId);
  const wire: bridgeContracts.BatchRestRecordedWire = {
    batch_no: run.batch_number ?? '',
    oil_batch_ref: run.oil_batch_id,
    started_at: new Date(ts(run.started_at)).toISOString(),
    closed_at: now.toISOString(),
    days_rested: p.daysRested,
    required_days: p.needDays,
    // A run opened before PROM-2 has no rule recorded: its own minimum stands in, version 0.
    rule_days: Number(run.rule_days ?? run.min_days),
    rule_version: Number(run.rule_version ?? 0),
    early_release: earlyRelease,
    early_release_reason_code: earlyRelease ? ((run.early_release_reason_code as bridgeContracts.AwayFromCautionReasonCode | null) ?? 'other') : null,
    // No zone log is linked to an oil batch yet (FLOOR-TEMP-1 logs zones and bins, not batches), so
    // the lot page says "Temperature log: Not on file" rather than inferring one.
    temperature: null,
  };
  const problems = bridgeContracts.checkBatchRestRecordedWire(wire);
  if (problems.length) throw new ConflictException(`The rest record could not be sent: ${problems.join(', ')}. A batch is released only with its record.`);
  bridgeContracts.assertNoFormulaContent(wire);
  await emitBridgeManualEvent(tx, bridgeContracts.BATCH_REST_RECORDED, run.maceration_run_id, wire as unknown as Record<string, unknown>);
}

/**
 * Called by the oil-batch state machine INSIDE its transaction, after the status moved. Throwing
 * rolls the move back.
 */
export async function macerationOnTransition(
  tx: BridgeEmitTx,
  t: { oilBatchId: string; from: string; to: string; userId: string | null },
  now: Date = new Date(),
): Promise<void> {
  if (t.to === 'IN_MATURATION' || t.to === 'MATURING') {
    // PROM-2: every batch rests. The branch rule sets the days; a formula's setting may lengthen them.
    const rule = await restRuleInForce(tx, { oilBatchId: t.oilBatchId });
    const found = (await rows<{ formula_id: string | null; required: boolean | null; min_days: number | null; max_days: number | null; freeze_required: boolean | null }>(tx, sql`
      select ppi.formula_id, ms.required, ms.min_days, ms.max_days, ms.freeze_required
        from production.oil_batch_master ob
        left join production.production_order po on po.production_order_id = ob.production_order_id
        left join production.production_plan_items ppi on ppi.production_plan_item_id = po.production_plan_item_id
        left join production.maceration_setting ms on ms.formula_id = ppi.formula_id and ms.required
       where ob.oil_batch_id = ${t.oilBatchId}`))[0];
    const setting = found?.required ? found : null;
    const minDays = Math.max(rule.value.minDays, Number(setting?.min_days ?? 0));
    const maxDays = setting ? Math.max(Number(setting.max_days), minDays) : rule.value.maxDays;
    const freezeRequired = setting?.freeze_required === true;
    // PROM-3: with the reference rule on, QC 1 is an approved round, not a typed PASS.
    const refRule = await referenceRuleInForce(tx, { oilBatchId: t.oilBatchId });
    let qc1ProductionQcId: string | null = null, qc1RoundId: string | null = null;
    if (refRule.value.required) {
      const r = await latestRound(tx, t.oilBatchId);
      if (!r || r.stage !== 'QC1' || r.decision !== 'APPROVE') {
        throw new ConflictException('Every batch rests between QC 1 and QC 2: QC 1 (a full round on the product\'s checkpoints, compared with its retained reference) must be approved before the batch goes into maceration.');
      }
      qc1RoundId = r.batch_qc_round_id;
    } else {
      const qc1 = (await rows<{ production_qc_id: string; result: string | null }>(tx, sql`
        select production_qc_id, result from production.production_qc
         where oil_batch_id = ${t.oilBatchId} order by created_dt desc, production_qc_id desc limit 1`))[0];
      if (String(qc1?.result ?? '').toUpperCase() !== 'PASS') {
        throw new ConflictException('Every batch rests between QC 1 and QC 2: QC 1 (before maceration) must PASS before the batch goes into maceration.');
      }
      qc1ProductionQcId = qc1!.production_qc_id;
    }
    const existing = await openRun(tx, t.oilBatchId);
    if (existing) {
      if (t.from === 'REWORK') {
        await tx.execute(sql`
          update production.maceration_run
             set started_at = ${now.toISOString()}::timestamptz, restart_count = restart_count + 1, qc1_production_qc_id = ${qc1ProductionQcId}, qc1_round_id = ${qc1RoundId},
                 min_days = ${minDays}, max_days = ${maxDays}, rule_days = ${rule.value.minDays}, rule_version = ${rule.version}, rule_source = ${rule.source},
                 freeze_done_at = null, freeze_done_by = null, alarm_at = null, early_release_at = null, early_release_by = null,
                 early_release_reason = null, early_release_reason_code = null, early_release_requested_at = null, early_release_approved_by = null,
                 extend_days = 0, updated_at = ${now.toISOString()}::timestamptz
           where maceration_run_id = ${existing.maceration_run_id}`);
        await event(tx, existing.maceration_run_id, 'RESTARTED', 'rework: the timer starts again', t.userId);
      } else {
        await event(tx, existing.maceration_run_id, 'RESUMED', `from ${t.from}`, t.userId);
      }
      return;
    }
    const runId = randomUUID();
    await tx.execute(sql`
      insert into production.maceration_run (maceration_run_id, oil_batch_id, formula_id, status, started_at, min_days, max_days,
                                             freeze_required, qc1_production_qc_id, qc1_round_id, rule_days, rule_version, rule_source, created_by, created_at, updated_at)
      values (${runId}, ${t.oilBatchId}, ${found?.formula_id ?? null}, 'MACERATING', ${now.toISOString()}::timestamptz, ${minDays},
              ${maxDays}, ${freezeRequired}, ${qc1ProductionQcId}, ${qc1RoundId}, ${rule.value.minDays}, ${rule.version}, ${rule.source},
              ${t.userId && /^[0-9a-f-]{36}$/i.test(t.userId) ? t.userId : null}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`);
    await event(tx, runId, 'STARTED', `rule ${rule.source === 'policy' ? `maceration.rest v${rule.version}` : 'maceration.rest (registry default)'}: ${minDays} days`, t.userId);
    return;
  }

  if (t.to === 'RELEASED') {
    const run = await openRun(tx, t.oilBatchId);
    if (!run) {
      // PROM-2: HOLD -> RELEASED and REWORK -> RELEASED no longer skip the rest.
      const rule = await restRuleInForce(tx, { oilBatchId: t.oilBatchId });
      const [b] = await rows<{ batch_number: string | null }>(tx, sql`select batch_number from production.oil_batch_master where oil_batch_id = ${t.oilBatchId}`);
      throw new ConflictException(
        `Batch ${b?.batch_number ?? t.oilBatchId} has not rested. Every batch rests ${rule.value.minDays} days between QC 1 and QC 2 (branch rule maceration.rest ${rule.version ? `v${rule.version}` : 'registry default'}). Send it into maceration after QC 1.`,
      );
    }
    const p = macerationProgress(run, now);
    if (!p.minReached && !p.releasedEarly) {
      throw new ConflictException(`Batch ${run.batch_number ?? t.oilBatchId} is on day ${p.day} of ${p.needDays} of maceration. An early release needs a second person to approve it, with a reason; QC 2 is still required.`);
    }
    if (run.freeze_required && !run.freeze_done_at) {
      throw new ConflictException('The freeze / chill-filter step has not been recorded for this batch.');
    }
    const refRule = await referenceRuleInForce(tx, { oilBatchId: t.oilBatchId });
    if (refRule.value.required) {
      // PROM-3: QC 2 is an approved round taken AFTER the rest ended, with what it compared with on
      // record, and a sample of this batch retained so a complaint can be re-tested against it.
      const ended = restEndedAt(run, now);
      const r = await latestRound(tx, t.oilBatchId);
      if (!r || r.stage !== 'QC2' || r.decision !== 'APPROVE' || !ended || Number(r.created_ms) < ended.getTime()) {
        throw new ConflictException('QC 2 (a full round on the same checkpoints, compared with the retained reference, taken after the rest) must be approved before the batch is released. A typed QC result does not release a batch.');
      }
      if (!r.reference_basis) throw new ConflictException('QC 2 did not record what it was compared with, so the batch is not released.');
      const [kept] = await rows<{ one: number }>(tx, sql`select 1 as one from quality.qc_sample_retention where oil_batch_id = ${t.oilBatchId} limit 1`);
      if (!kept) throw new ConflictException('Retain a sample of this batch before it is released: a complaint about the lot is re-tested against it.');
    } else {
      const qc2 = (await rows<{ result: string | null }>(tx, sql`
        select result from production.production_qc
         where oil_batch_id = ${t.oilBatchId} and created_dt >= ${new Date(ts(run.started_at)).toISOString()}::timestamptz
         order by created_dt desc, production_qc_id desc limit 1`))[0];
      if (String(qc2?.result ?? '').toUpperCase() !== 'PASS') {
        throw new ConflictException('QC 2 (after maceration) must PASS before the batch is released.');
      }
    }
    await closeRun(tx, run, p, now, t.userId);
    return;
  }

  if (t.to === 'FAILED') {
    const run = await openRun(tx, t.oilBatchId);
    if (!run) return;
    await tx.execute(sql`update production.maceration_run set status = 'CANCELLED', closed_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz where maceration_run_id = ${run.maceration_run_id}`);
    await event(tx, run.maceration_run_id, 'CANCELLED', 'batch failed', t.userId);
  }
}
