/**
 * PROD-D-2 — pipeline intelligence over the floor queue (production-floor plan 12.3), pure.
 *
 *   stationMedians  how long each station takes, measured from finished floor jobs: PICK from the
 *                   job opening to the pick completing, VERIFY pick -> verify, MIX verify -> mix.
 *                   The median, so one stuck job does not move every prediction.
 *   predictLate     walks the queue in its ranked order through PICK -> VERIFY -> MIX, each station
 *                   working one job at a time (the backlog), a waiting job starting no earlier than
 *                   its stock is due, then adds the formula's maceration days and the measured QC
 *                   days. Finish past the promise date = "will be late by N days" (any part of a day
 *                   counts as a day) and the job is AT RISK before it is Delayed. Nothing is guessed:
 *                   no measured station time, or stock with no PO or lead time, gives no prediction
 *                   and says why.
 *   groupByFormula  runs two jobs of the same formula back to back to save a changeover, but only
 *                   when no job ends up more than one slot from where strict alternation put it,
 *                   and only among ready ALTERNATE jobs: expedited, top, held, waiting and suggested
 *                   jobs stay where the rule put them.
 */
import type { RankedJob, QueueJob } from './floor-queue.service.js';

const DAY = 86_400_000;
export const STAGES = ['PICK', 'VERIFY', 'MIX'] as const;
type Stage = (typeof STAGES)[number];

export interface Medians { PICK: number | null; VERIFY: number | null; MIX: number | null; samples: number }

export interface DoneJob { createdDt: string; pickedDt: string | null; verifiedDt: string | null; mixedDt: string | null }

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}
const span = (a: string | null, b: string | null) => {
  const x = a ? Date.parse(a) : NaN, y = b ? Date.parse(b) : NaN;
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null;
};

export function stationMedians(done: DoneJob[]): Medians {
  const p: number[] = [], v: number[] = [], m: number[] = [];
  for (const d of done) {
    const a = span(d.createdDt, d.pickedDt), b = span(d.pickedDt, d.verifiedDt), c = span(d.verifiedDt, d.mixedDt);
    if (a != null) p.push(a);
    if (b != null) v.push(b);
    if (c != null) m.push(c);
  }
  return { PICK: median(p), VERIFY: median(v), MIX: median(m), samples: Math.min(p.length, v.length, m.length) };
}

export type PipelineJob = (QueueJob | RankedJob) & {
  macerationDays: number;
  /** When the stock a waiting job needs is due: ISO, null when nothing is waited on, undefined when unknown. */
  stockReadyAt: string | null | undefined;
};

export interface Prediction { finishAt: string | null; lateByDays: number; atRisk: boolean; explain: string }

const days = (ms: number) => Math.round((ms / DAY) * 10) / 10;

export function predictLate(jobs: PipelineJob[], m: Medians, qcDays: number | null, now: Date): Map<string, Prediction> {
  const out = new Map<string, Prediction>();
  if (m.PICK == null || m.VERIFY == null || m.MIX == null) {
    for (const j of jobs) out.set(j.floorJobId, { finishAt: null, lateByDays: 0, atRisk: false, explain: 'No station times measured yet: a prediction needs finished jobs to learn from.' });
    return out;
  }
  const free: Record<Stage, number> = { PICK: now.getTime(), VERIFY: now.getTime(), MIX: now.getTime() };
  for (const j of jobs) {
    if (!j.ready && j.stockReadyAt === undefined) {
      out.set(j.floorJobId, { finishAt: null, lateByDays: 0, atRisk: false, explain: `Cannot predict: waiting on ${j.waitingOn.join(', ')} with no PO or lead time on record.` });
      continue;
    }
    const from = STAGES.indexOf(j.stage as Stage);
    if (from < 0) continue;
    let t = j.stockReadyAt ? Math.max(now.getTime(), Date.parse(j.stockReadyAt)) : now.getTime();
    for (const s of STAGES.slice(from)) {
      const start = Math.max(t, free[s]);
      t = start + m[s]!;
      free[s] = t;
    }
    const floorDone = t;
    t += j.macerationDays * DAY + (qcDays ?? 0) * DAY;
    const parts = [`floor done in ${days(floorDone - now.getTime())} days`];
    if (j.stockReadyAt) parts.push(`stock for ${j.waitingOn.join(', ') || 'it'} due ${j.stockReadyAt.slice(0, 10)}`);
    if (j.macerationDays) parts.push(`${j.macerationDays} days maceration`);
    if (qcDays) parts.push(`${qcDays} days QC`);
    const promise = j.promiseDt ? Date.parse(j.promiseDt) : NaN;
    const late = Number.isFinite(promise) && t > promise ? Math.ceil((t - promise) / DAY) : 0;
    const head = !Number.isFinite(promise) ? 'No promise date' : late ? `Will be late by ${late} day${late === 1 ? '' : 's'}` : 'On time';
    out.set(j.floorJobId, { finishAt: new Date(t).toISOString(), lateByDays: late, atRisk: late > 0, explain: `${head}: ${parts.join(', ')} (from ${m.samples} measured job${m.samples === 1 ? '' : 's'}).` });
  }
  return out;
}

/** Same-formula jobs back to back, never moving any job more than one slot. Positions renumbered. */
export function groupByFormula(ranked: RankedJob[], formulaOf: (j: RankedJob) => string | null): RankedJob[] {
  const list = ranked.map((j) => ({ ...j }));
  const orig = new Map(list.map((j, i) => [j.floorJobId, i]));
  const movable = (j: RankedJob) => j.ready && j.priority === 'ALTERNATE';
  for (let i = 0; i + 2 < list.length; i++) {
    const a = list[i]!, b = list[i + 1]!, c = list[i + 2]!;
    const fa = formulaOf(a), fb = formulaOf(b), fc = formulaOf(c);
    if (!fa || !movable(a) || !movable(b) || !movable(c) || fb === fa || fc !== fa) continue;
    // c moves up to i+1, b down to i+2: both must stay within one slot of their rule position.
    if (Math.abs(orig.get(c.floorJobId)! - (i + 1)) > 1 || Math.abs(orig.get(b.floorJobId)! - (i + 2)) > 1) continue;
    list[i + 1] = { ...c, why: `Grouped with the same formula as ${a.jobNo} to save a changeover (moved up one slot). ${c.why}` };
    list[i + 2] = b;
  }
  let pos = 0;
  for (const j of list) if (j.position != null) j.position = ++pos;
  return list;
}
