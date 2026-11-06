/**
 * PROD-A-6 — the floor queue: which job the floor makes next (production-floor plan §5, §12.3).
 *
 *   Lanes      New (not past its promise date; no promise date reads New) and Delayed (past it).
 *   Order      expedited first; then any job the `floor.queue` policy sends to the top; then strict
 *              alternation New, Delayed, New, Delayed … with New first, FIFO inside New and most
 *              overdue first inside Delayed. The default policy is strict alternation.
 *   Readiness  a PICK job is ready only when every line has a released, unexpired lot holding enough.
 *              A job that is not ready says what it is waiting on ("Waiting on YELLOW-0417") and the
 *              next READY job is pulled ahead of it, so a station never starves behind a blocked job.
 *   Hold       if the policy cannot answer for a job (no rule, no default), the job is HELD and says
 *              why; it is never ranked by a guess.
 *
 * PROD-D-2 adds, on top: a SUGGESTED job (from an approved order-intelligence suggestion, plan 11)
 * ranks below every customer job; a ready job pulled ahead of a waiting one says which job it
 * passed and why; and pipeline.ts predicts "will be late by N days" and groups same-formula jobs
 * where that moves a job one slot at most.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { PolicyService, PolicyUnresolved } from '../policy/policy.service.js';
import { FloorCodeService, qtyToMg } from './floor-code.service.js';

export interface QueueJob {
  floorJobId: string;
  jobNo: string;
  stage: string;
  orderRef: string | null;
  tote: string | null;
  promiseDt: string | null;
  createdDt: string;
  expedite: boolean;
  channel: string | null;
  customerTier: string | null;
  ready: boolean;
  waitingOn: string[];
  /** ORDER (a customer order, the default) or SUGGESTED (an approved cover suggestion). */
  source?: 'ORDER' | 'SUGGESTED';
}

export interface RankedJob extends QueueJob {
  position: number | null;
  lane: 'NEW' | 'DELAYED';
  daysLate: number;
  priority: 'EXPEDITE' | 'TOP' | 'ALTERNATE' | 'SUGGESTED' | 'HOLD';
  why: string;
  policyVersion: number | null;
}

const DAY = 86_400_000;

/** Whole days past the promise (0 when not late or no promise). */
export function daysLate(promiseDt: string | null, now: Date): number {
  if (!promiseDt) return 0;
  const t = Date.parse(promiseDt);
  if (!Number.isFinite(t) || t >= now.getTime()) return 0;
  return Math.max(1, Math.floor((now.getTime() - t) / DAY));
}

/** New, Delayed, New, Delayed … New first; whichever lane runs out, the other continues. */
export function alternate<T>(fresh: T[], late: T[]): T[] {
  const out: T[] = [];
  let i = 0, j = 0, takeNew = true;
  while (i < fresh.length || j < late.length) {
    if ((takeNew && i < fresh.length) || j >= late.length) out.push(fresh[i++]!);
    else out.push(late[j++]!);
    takeNew = !takeNew;
  }
  return out;
}

/**
 * Pure ranking. `decide(job)` is the floor.queue policy's answer for that job: a value whose
 * `priority === 'top'` lifts it to the top group, anything else keeps alternation; `null` = HOLD.
 */
export function rankQueue(
  jobs: QueueJob[],
  now: Date,
  decide: (j: QueueJob & { daysLate: number; lane: 'NEW' | 'DELAYED' }) => { value: unknown; explain: string; version: number } | null,
): RankedJob[] {
  const enriched = jobs.map((j) => {
    const dl = daysLate(j.promiseDt, now);
    const lane: 'NEW' | 'DELAYED' = dl > 0 ? 'DELAYED' : 'NEW';
    return { ...j, daysLate: dl, lane };
  });
  const fifo = (a: { createdDt: string }, b: { createdDt: string }) => a.createdDt.localeCompare(b.createdDt);
  const overdue = (a: { daysLate: number; promiseDt: string | null; createdDt: string }, b: typeof a) =>
    b.daysLate - a.daysLate || String(a.promiseDt).localeCompare(String(b.promiseDt)) || fifo(a, b);

  const held: RankedJob[] = [];
  const groups: Record<'EXPEDITE' | 'TOP' | 'ALTERNATE' | 'SUGGESTED', RankedJob[]> = { EXPEDITE: [], TOP: [], ALTERNATE: [], SUGGESTED: [] };
  for (const j of enriched) {
    const d = decide(j);
    if (!d) {
      held.push({ ...j, position: null, priority: 'HOLD', why: 'The queue rule has no answer for this job: held until an admin sets one', policyVersion: null });
      continue;
    }
    const v = d.value as { priority?: string } | null;
    // A suggested job is stock for later, not a customer waiting: below every customer job, unless
    // an admin expedites it (an explicit call) — the floor.queue rule cannot lift it above orders.
    const priority = j.expedite ? 'EXPEDITE' : j.source === 'SUGGESTED' ? 'SUGGESTED'
      : v && typeof v === 'object' && String(v.priority).toLowerCase() === 'top' ? 'TOP' : 'ALTERNATE';
    const why = priority === 'EXPEDITE' ? 'Expedited by an admin' : priority === 'TOP' ? d.explain
      : priority === 'SUGGESTED' ? 'Suggested by order intelligence and approved: below every customer order'
      : `${j.lane === 'NEW' ? 'New' : `Delayed ${j.daysLate} day(s)`}; ${d.explain}`;
    groups[priority].push({ ...j, position: null, priority, why, policyVersion: d.version });
  }
  const ordered = [
    ...groups.EXPEDITE.sort(fifo),
    ...groups.TOP.sort(overdue),
    ...alternate(groups.ALTERNATE.filter((j) => j.lane === 'NEW').sort(fifo), groups.ALTERNATE.filter((j) => j.lane === 'DELAYED').sort(overdue)),
    ...groups.SUGGESTED.sort(fifo),
  ];
  // A station never starves: ready jobs keep their relative order and come first; waiting jobs
  // follow in the same order, each saying what it waits on. A ready job that passed a waiting one
  // names the job it passed (PROD-D-2), so nobody reads the jump as the rule being ignored.
  const ready = ordered.filter((j) => j.ready).map((j) => {
    const passed = ordered.slice(0, ordered.indexOf(j)).filter((w) => !w.ready);
    if (!passed.length) return j;
    const w = passed[0]!;
    return { ...j, why: `Pulled ahead of ${w.jobNo} (waiting on ${w.waitingOn.join(', ')})${passed.length > 1 ? ` and ${passed.length - 1} more waiting` : ''} so the station keeps working. ${j.why}` };
  });
  const waiting = ordered.filter((j) => !j.ready).map((j) => ({ ...j, why: `Waiting on ${j.waitingOn.join(', ')}. ${j.why}` }));
  const all = [...ready, ...waiting];
  all.forEach((j, i) => (j.position = i + 1));
  return [...all, ...held];
}

@Injectable()
export class FloorQueueService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly policies: PolicyService,
    private readonly codes: FloorCodeService,
  ) {}

  /** Jobs not yet DONE, with readiness. `stage` narrows to one station. */
  async jobs(stage?: string | null): Promise<QueueJob[]> {
    const rows = await this.sql<{
      floor_job_id: string; job_no: string; stage: string; order_ref: string | null; tote: string | null; promise_dt: string | null;
      created_dt: string; expedite: boolean; channel: string | null; customer_tier: string | null;
    }[]>`
      select floor_job_id::text, job_no, stage, order_ref, tote, promise_dt::text, created_dt::text, expedite, channel, customer_tier
        from production.floor_job
       where stage <> 'DONE' ${stage ? this.sql`and stage = ${stage.toUpperCase()}` : this.sql``}
       order by created_dt limit 500`;
    const out: QueueJob[] = [];
    for (const r of rows) {
      const waitingOn: string[] = [];
      if (r.stage === 'PICK') {
        const lines = await this.sql<{ material_id: string; target_mg: string; picked: boolean }[]>`
          select material_id::text, target_mg::text, picked_batch_id is not null as picked from production.floor_line where floor_job_id = ${r.floor_job_id} order by seq`;
        for (const l of lines) {
          if (l.picked) continue;
          const lots = await this.sql<{ qty: string; uom_code: string | null }[]>`
            select ib.quantity_on_hand::text as qty, u.uom_code from inventory.inventory_batch ib
              join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
              left join platform.uom_master u on u.uom_id = ib.uom_id
              join lateral (select overall_result from quality.qc_inspections q where q.rm_batch_id = ib.rm_batch_id order by created_dt desc limit 1) qc on true
             where ib.material_id = ${l.material_id} and ib.quantity_on_hand > 0 and upper(coalesce(qc.overall_result, '')) in ('ACCEPT', 'PASS')
               and (rb.expiry_date is null or rb.expiry_date >= current_date)`;
          const enough = lots.some((x) => (qtyToMg(x.qty, x.uom_code) ?? -1) >= Number(l.target_mg));
          if (!enough) waitingOn.push((await this.codes.codeFor(l.material_id))?.code ?? 'an uncoded line');
        }
      }
      out.push({
        floorJobId: r.floor_job_id, jobNo: r.job_no, stage: r.stage, orderRef: r.order_ref, tote: r.tote, promiseDt: r.promise_dt,
        createdDt: r.created_dt, expedite: r.expedite, channel: r.channel, customerTier: r.customer_tier,
        ready: waitingOn.length === 0, waitingOn,
      });
    }
    return out;
  }

  async queue(stage?: string | null, at?: Date) {
    const now = at ?? new Date();
    const jobs = await this.jobs(stage);
    const answers = new Map<string, { value: unknown; explain: string; version: number } | null>();
    for (const j of jobs) {
      const dl = daysLate(j.promiseDt, now);
      try {
        const r = await this.policies.evaluate('floor.queue', {
          record_type: 'floor_job', record_id: j.jobNo, channel: j.channel, customer_tier: j.customerTier,
          days_late: dl, expedite: j.expedite, stage: j.stage, lane: dl > 0 ? 'delayed' : 'new',
        }, at); // no `at`: the policy store reads the database's own now()
        answers.set(j.floorJobId, { value: r.value, explain: r.explain, version: r.version });
      } catch (e) {
        if (e instanceof PolicyUnresolved) answers.set(j.floorJobId, null);
        else throw e;
      }
    }
    const items = rankQueue(jobs, now, (j) => answers.get(j.floorJobId) ?? null);
    return {
      items,
      counters: {
        total: items.length,
        ready: items.filter((i) => i.ready && i.priority !== 'HOLD').length,
        waiting: items.filter((i) => !i.ready).length,
        delayed: items.filter((i) => i.lane === 'DELAYED').length,
        held: items.filter((i) => i.priority === 'HOLD').length,
      },
    };
  }
}
