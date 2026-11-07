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
import { mgToQty } from '@core/data-kernel';
import { FloorCodeService, qtyToMg } from './floor-code.service.js';
import { stationMedians, predictLate, groupByFormula, type PipelineJob, type Prediction } from './pipeline.js';

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
    // WALK2-RP-17: the picker read the engine's trace ("New; No rule matched → otherwise {"mode":"alternate"}")
    // and "1 day(s)". The default turn is said in words; a matched rule keeps its own explanation.
    const late = `Delayed ${j.daysLate} ${j.daysLate === 1 ? 'day' : 'days'}`;
    const turn = /^No rule matched/.test(d.explain) ? (j.lane === 'NEW' ? 'taken in turn with delayed jobs' : 'taken in turn with new jobs') : d.explain;
    const why = priority === 'EXPEDITE' ? 'Expedited by an admin' : priority === 'TOP' ? d.explain
      : priority === 'SUGGESTED' ? 'Suggested by order intelligence and approved: below every customer order'
      : `${j.lane === 'NEW' ? 'New' : late}: ${turn}`;
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
      created_dt: string; expedite: boolean; channel: string | null; customer_tier: string | null; source: string | null;
    }[]>`
      select floor_job_id::text, job_no, stage, order_ref, tote, promise_dt::text, created_dt::text, expedite, channel, customer_tier, source
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
          const enough = lots.some((x) => (qtyToMg(x.qty, x.uom_code) ?? -1) >= Number(l.target_mg) && mgToQty(Number(l.target_mg), x.uom_code) !== null);
          if (!enough) waitingOn.push((await this.codes.codeFor(l.material_id))?.code ?? 'an uncoded line');
        }
      }
      out.push({
        floorJobId: r.floor_job_id, jobNo: r.job_no, stage: r.stage, orderRef: r.order_ref, tote: r.tote, promiseDt: r.promise_dt,
        createdDt: r.created_dt, expedite: r.expedite, channel: r.channel, customerTier: r.customer_tier,
        ready: waitingOn.length === 0, waitingOn, source: r.source === 'SUGGESTED' ? 'SUGGESTED' : 'ORDER',
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
    const ranked = rankQueue(jobs, now, (j) => answers.get(j.floorJobId) ?? null);
    const pipe = await this.pipeline(ranked, now);
    const items = groupByFormula(ranked, (j) => pipe.formula.get(j.floorJobId) ?? null)
      .map((j) => ({ ...j, prediction: pipe.predictions.get(j.floorJobId) ?? null }));
    return {
      items,
      planned: await this.planned(),
      pipeline: { measuredJobs: pipe.samples, atRisk: items.filter((i) => i.prediction?.atRisk).length },
      counters: {
        total: items.length,
        ready: items.filter((i) => i.ready && i.priority !== 'HOLD').length,
        waiting: items.filter((i) => !i.ready).length,
        delayed: items.filter((i) => i.lane === 'DELAYED').length,
        held: items.filter((i) => i.priority === 'HOLD').length,
      },
    };
  }

  /** PROD-D-2: what pipeline.ts needs from the database: measured station times, QC days, each job's
   *  formula (grouping only, never returned) and maceration days, and when waited-on stock is due. */
  private async pipeline(ranked: RankedJob[], now: Date): Promise<{ predictions: Map<string, Prediction>; formula: Map<string, string>; samples: number }> {
    const done = await this.sql<{ created_dt: string; picked_dt: string | null; verified_dt: string | null; mixed_dt: string | null }[]>`
      select created_dt::text, picked_dt::text, verified_dt::text, mixed_dt::text from production.floor_job
       where stage = 'DONE' and mixed_dt is not null order by mixed_dt desc limit 50`;
    const m = stationMedians(done.map((d) => ({ createdDt: d.created_dt, pickedDt: d.picked_dt, verifiedDt: d.verified_dt, mixedDt: d.mixed_dt })));
    const qc = await this.sql<{ d: number }[]>`
      select extract(epoch from (r.created_dt - coalesce(ob.produced_dt, ob.created_dt)))::float8 / 86400 as d
        from quality.batch_qc_round r join production.oil_batch_master ob on ob.oil_batch_id = r.oil_batch_id
       where r.decision = 'APPROVE' order by r.created_dt desc limit 50`;
    const qs = qc.map((r) => Math.max(0, Number(r.d))).sort((a, b) => a - b);
    const qcDays = qs.length ? Math.round(qs[Math.floor(qs.length / 2)]! * 10) / 10 : null;
    const formula = new Map<string, string>();
    const jobs: PipelineJob[] = [];
    const live = ranked.filter((j) => j.priority !== 'HOLD');
    const ids = live.map((j) => j.floorJobId);
    const meta = ids.length ? await this.sql<{ floor_job_id: string; formula_id: string | null; mac: number | null }[]>`
      select fj.floor_job_id::text, coalesce(pm.formula_id, ppi.formula_id)::text as formula_id,
             (select ms.min_days from production.maceration_setting ms where ms.formula_id = coalesce(pm.formula_id, ppi.formula_id) and ms.required) as mac
        from production.floor_job fj join production.production_order po on po.production_order_id = fj.production_order_id
        left join production.production_plan_items ppi on ppi.production_plan_item_id = po.production_plan_item_id
        left join lateral (select s.product_id from bridge.production_requirement r join packaging.product_sku s on s.sku_code = r.mapped_sku
                            where r.production_order_id = po.production_order_id limit 1) sk on true
        left join packaging.product_master pm on pm.product_id = sk.product_id
       where fj.floor_job_id = any(${ids}::uuid[])` : [];
    const byId = new Map(meta.map((r) => [r.floor_job_id, r]));
    for (const j of live) {
      const r = byId.get(j.floorJobId);
      if (r?.formula_id) formula.set(j.floorJobId, r.formula_id);
      let stockReadyAt: string | null | undefined = null;
      if (!j.ready) stockReadyAt = await this.stockDue(j.floorJobId, now);
      jobs.push({ ...j, macerationDays: Number(r?.mac ?? 0), stockReadyAt });
    }
    return { predictions: predictLate(jobs, m, qcDays, now), formula, samples: m.samples };
  }

  /** When the last unpicked short line's stock is due: an open PO's order date + the vendor lead time,
   *  else today + the preferred vendor's lead time; undefined when neither is on record. */
  private async stockDue(jobId: string, now: Date): Promise<string | undefined> {
    const lines = await this.sql<{ material_id: string }[]>`select material_id::text from production.floor_line where floor_job_id = ${jobId} and picked_batch_id is null`;
    let latest = now.getTime();
    for (const l of lines) {
      const [po] = await this.sql<{ due: string | null }[]>`
        select min(po.order_date + make_interval(days => coalesce(vm.lead_time_days, 0)))::text as due
          from procurement.purchase_order_items poi join procurement.purchase_order po on po.purchase_order_id = poi.purchase_order_id
          left join procurement.vendor_rm_mapping vm on vm.vendor_id = po.vendor_id and vm.material_id = poi.material_id
         where poi.material_id = ${l.material_id} and upper(coalesce(po.status, '')) in ('APPROVED', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED')
           and po.order_date is not null and vm.lead_time_days is not null`;
      let due = po?.due ? Date.parse(po.due) : NaN;
      if (!Number.isFinite(due)) {
        const [vm] = await this.sql<{ d: number | null }[]>`select lead_time_days as d from procurement.vendor_rm_mapping where material_id = ${l.material_id} and lead_time_days is not null order by is_preferred desc nulls last limit 1`;
        if (vm?.d == null) {
          // A line with enough stock is not what the job waits on; only a short line with no date is unknown.
          continue;
        }
        due = now.getTime() + Number(vm.d) * 86_400_000;
      }
      latest = Math.max(latest, due);
    }
    return latest > now.getTime() ? new Date(latest).toISOString() : undefined;
  }

  /** Approved cover suggestions not yet on the floor: below every customer job, waiting for a job. */
  private async planned() {
    return this.sql`select cover_suggestion_id::text as "coverSuggestionId", sku_code as sku, qty_units as qty, reasoning, decided_by as "approvedBy", decided_dt as "approvedDt",
                           'Approved suggestion: production opens a job for it; it then ranks below every customer order.' as why
                      from production.cover_suggestion where status = 'APPROVED' and floor_job_id is null order by decided_dt limit 100`;
  }
}
