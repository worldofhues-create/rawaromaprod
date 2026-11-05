/**
 * Maceration gate (lane pf-c, production-floor plan section 8) — shared by the clusters that move
 * a batch (production), ship it (sales), reserve it or move it as finished goods (packaging, shelf).
 * Lives in the kernel beside bridge-emit for the same reason: several clusters call it inside their
 * own transaction, and none may import another.
 *
 * Flow for a formula with maceration required (production.maceration_setting):
 *   Mixer -> QC 1 PASS -> IN_MATURATION (a run opens, the timer starts) -> freeze/chill-filter step
 *   (when required) -> minimum days reached (or an admin's early release, with a reason) -> QC 2 PASS
 *   recorded after the run started -> RELEASED (the run closes).
 *   REWORK -> IN_MATURATION restarts the timer. FAILED cancels the run.
 *
 * While a run is open the batch cannot ship, become/move as finished goods, or be reserved: the
 * system refuses, it does not warn. A formula without the setting behaves exactly as before.
 */
import { ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BridgeEmitTx } from './bridge-emit.js';

const DAY_MS = 86_400_000;

interface RunRow {
  maceration_run_id: string;
  oil_batch_id: string;
  batch_number: string | null;
  started_at: string | Date;
  min_days: number;
  max_days: number;
  extend_days: number;
  freeze_required: boolean;
  freeze_done_at: string | Date | null;
  early_release_at: string | Date | null;
}

const ts = (v: string | Date) => (v instanceof Date ? v : new Date(String(v).replace(' ', 'T'))).getTime();
async function rows<T>(tx: BridgeEmitTx, q: unknown): Promise<T[]> {
  return Array.from((await tx.execute(q)) as unknown as T[]);
}

/** Day N (1-based) of the run, and whether its minimum time has passed. */
export function macerationProgress(run: { started_at: string | Date; min_days: number; extend_days: number; max_days: number; early_release_at?: string | Date | null }, now: Date) {
  const elapsedMs = Math.max(0, now.getTime() - ts(run.started_at));
  const day = Math.floor(elapsedMs / DAY_MS) + 1;
  const needDays = Number(run.min_days) + Number(run.extend_days ?? 0);
  const minReached = elapsedMs >= needDays * DAY_MS;
  return { day, needDays, maxDays: Number(run.max_days), minReached, overMax: elapsedMs > Number(run.max_days) * DAY_MS, releasedEarly: !!run.early_release_at };
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
    const setting = (await rows<{ formula_id: string; min_days: number; max_days: number; freeze_required: boolean }>(tx, sql`
      select ms.formula_id, ms.min_days, ms.max_days, ms.freeze_required
        from production.oil_batch_master ob
        join production.production_order po on po.production_order_id = ob.production_order_id
        join production.production_plan_items ppi on ppi.production_plan_item_id = po.production_plan_item_id
        join production.maceration_setting ms on ms.formula_id = ppi.formula_id
       where ob.oil_batch_id = ${t.oilBatchId} and ms.required`))[0];
    if (!setting) return;
    const qc1 = (await rows<{ production_qc_id: string; result: string | null }>(tx, sql`
      select production_qc_id, result from production.production_qc
       where oil_batch_id = ${t.oilBatchId} order by created_dt desc, production_qc_id desc limit 1`))[0];
    if (String(qc1?.result ?? '').toUpperCase() !== 'PASS') {
      throw new ConflictException('This product macerates: QC 1 (before maceration) must PASS before the batch goes into maceration.');
    }
    const existing = await openRun(tx, t.oilBatchId);
    if (existing) {
      if (t.from === 'REWORK') {
        await tx.execute(sql`
          update production.maceration_run
             set started_at = ${now.toISOString()}::timestamptz, restart_count = restart_count + 1, qc1_production_qc_id = ${qc1!.production_qc_id},
                 freeze_done_at = null, freeze_done_by = null, alarm_at = null, early_release_at = null, early_release_by = null,
                 early_release_reason = null, extend_days = 0, updated_at = ${now.toISOString()}::timestamptz
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
                                             freeze_required, qc1_production_qc_id, created_by, created_at, updated_at)
      values (${runId}, ${t.oilBatchId}, ${setting.formula_id}, 'MACERATING', ${now.toISOString()}::timestamptz, ${setting.min_days},
              ${setting.max_days}, ${setting.freeze_required}, ${qc1!.production_qc_id},
              ${t.userId && /^[0-9a-f-]{36}$/i.test(t.userId) ? t.userId : null}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`);
    await event(tx, runId, 'STARTED', null, t.userId);
    return;
  }

  if (t.to === 'RELEASED') {
    const run = await openRun(tx, t.oilBatchId);
    if (!run) return;
    const p = macerationProgress(run, now);
    if (!p.minReached && !p.releasedEarly) {
      throw new ConflictException(`Batch ${run.batch_number ?? t.oilBatchId} is on day ${p.day} of ${p.needDays} of maceration. Only an admin can release it early, with a reason; QC 2 is still required.`);
    }
    if (run.freeze_required && !run.freeze_done_at) {
      throw new ConflictException('The freeze / chill-filter step has not been recorded for this batch.');
    }
    const qc2 = (await rows<{ result: string | null }>(tx, sql`
      select result from production.production_qc
       where oil_batch_id = ${t.oilBatchId} and created_dt >= ${new Date(ts(run.started_at)).toISOString()}::timestamptz
       order by created_dt desc, production_qc_id desc limit 1`))[0];
    if (String(qc2?.result ?? '').toUpperCase() !== 'PASS') {
      throw new ConflictException('QC 2 (after maceration) must PASS before the batch is released.');
    }
    await tx.execute(sql`update production.maceration_run set status = 'CLOSED', closed_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz where maceration_run_id = ${run.maceration_run_id}`);
    await event(tx, run.maceration_run_id, 'CLOSED', 'QC 2 passed; released', t.userId);
    return;
  }

  if (t.to === 'FAILED') {
    const run = await openRun(tx, t.oilBatchId);
    if (!run) return;
    await tx.execute(sql`update production.maceration_run set status = 'CANCELLED', closed_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz where maceration_run_id = ${run.maceration_run_id}`);
    await event(tx, run.maceration_run_id, 'CANCELLED', 'batch failed', t.userId);
  }
}
