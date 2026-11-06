/**
 * PROD-D-2 — pipeline intelligence on the floor queue (plan 12.3), pure: "will be late by N days"
 * from measured station times, maceration and stock; jobs at risk; a starving station pulls the
 * next ready job and says why; same-formula grouping only when it moves a job one slot at most;
 * approved suggestions below every customer order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankQueue, type QueueJob } from '../floor/floor-queue.service.js';
import { stationMedians, predictLate, groupByFormula, type PipelineJob } from '../floor/pipeline.js';

const NOW = new Date('2026-11-07T08:00:00Z');
const H = 3_600_000, DAY = 24 * H;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function job(no: string, over: Partial<QueueJob> = {}): QueueJob {
  return { floorJobId: no, jobNo: no, stage: 'PICK', orderRef: 'O-' + no, tote: null, promiseDt: null, createdDt: at(-DAY + Number(no.slice(2)) * 1000),
    expedite: false, channel: null, customerTier: null, ready: true, waitingOn: [], ...over };
}
const alt = () => ({ value: { priority: 'alternate' }, explain: 'Otherwise: alternate', version: 1 });

test('station medians come from finished jobs: pick, verify and mix each measured on their own', () => {
  const t0 = Date.parse('2026-11-01T08:00:00Z');
  const done = [1, 2, 3].map((k) => ({
    createdDt: new Date(t0).toISOString(), pickedDt: new Date(t0 + k * H).toISOString(),
    verifiedDt: new Date(t0 + k * H + 30 * 60_000).toISOString(), mixedDt: new Date(t0 + k * H + 30 * 60_000 + 2 * H).toISOString(),
  }));
  const m = stationMedians(done);
  assert.equal(m.PICK, 2 * H);
  assert.equal(m.VERIFY, 30 * 60_000);
  assert.equal(m.MIX, 2 * H);
  assert.deepEqual(stationMedians([]), { PICK: null, VERIFY: null, MIX: null, samples: 0 });
});

const medians = { PICK: 2 * H, VERIFY: H, MIX: 3 * H, samples: 5 };

test('late prediction: backlog, maceration and QC push a finish past the promise -> late by N days, at risk', () => {
  const jobs: PipelineJob[] = [
    { ...job('J-0001', { promiseDt: at(30 * DAY) }), macerationDays: 0, stockReadyAt: null },
    { ...job('J-0002', { promiseDt: at(10 * DAY) }), macerationDays: 14, stockReadyAt: null },
  ];
  const p = predictLate(jobs, medians, 1, NOW);
  const a = p.get('J-0001')!, b = p.get('J-0002')!;
  assert.equal(a.lateByDays, 0);
  assert.equal(a.atRisk, false);
  // J-0002 waits for J-0001 at each station, then 14 days maceration + 1 day QC: about 15.5 days out
  assert.equal(b.lateByDays, 6);
  assert.equal(b.atRisk, true);
  assert.match(b.explain, /Will be late by 6 days/);
  assert.match(b.explain, /14 days maceration/);
});

test('late prediction: a job waiting on stock starts when the stock is due; unknown stock date -> no guess', () => {
  const jobs: PipelineJob[] = [
    { ...job('J-0003', { ready: false, waitingOn: ['BLUE-0417'], promiseDt: at(3 * DAY) }), macerationDays: 0, stockReadyAt: at(5 * DAY) },
    { ...job('J-0004', { ready: false, waitingOn: ['PINK-0002'], promiseDt: at(3 * DAY) }), macerationDays: 0, stockReadyAt: undefined },
  ];
  const p = predictLate(jobs, medians, 0, NOW);
  assert.equal(p.get('J-0003')!.lateByDays, 3);
  assert.match(p.get('J-0003')!.explain, /BLUE-0417/);
  assert.equal(p.get('J-0004')!.finishAt, null);
  assert.match(p.get('J-0004')!.explain, /no PO or lead time/);
});

test('late prediction: nothing measured yet -> says so instead of predicting', () => {
  const p = predictLate([{ ...job('J-0005'), macerationDays: 0, stockReadyAt: null }], { PICK: null, VERIFY: null, MIX: null, samples: 0 }, null, NOW);
  assert.equal(p.get('J-0005')!.finishAt, null);
  assert.match(p.get('J-0005')!.explain, /No station times measured yet/);
});

test('late prediction: a job already at VERIFY only counts the stations it has left', () => {
  const p = predictLate([{ ...job('J-0006', { stage: 'VERIFY', promiseDt: at(2 * H) }), macerationDays: 0, stockReadyAt: null }], medians, 0, NOW);
  // verify 1h + mix 3h = 4h, promise in 2h -> late by 1 day (any part of a day)
  assert.equal(p.get('J-0006')!.lateByDays, 1);
});

test('starving station: the ready job is pulled ahead of a waiting one, and the reason names it', () => {
  const r = rankQueue([job('J-0001', { ready: false, waitingOn: ['BLUE-0417'] }), job('J-0002')], NOW, alt);
  assert.equal(r[0]!.jobNo, 'J-0002');
  assert.match(r[0]!.why, /Pulled ahead of J-0001 \(waiting on BLUE-0417\)/);
});

test('approved suggestions rank below every customer order', () => {
  const r = rankQueue([
    job('J-0001', { source: 'SUGGESTED' }),
    job('J-0002', { promiseDt: at(-3 * DAY) }),
    job('J-0003'),
  ], NOW, alt);
  assert.deepEqual(r.map((j) => j.jobNo), ['J-0003', 'J-0002', 'J-0001']);
  assert.equal(r[2]!.priority, 'SUGGESTED');
  assert.match(r[2]!.why, /below every customer order/);
  // an expedited suggestion is still an admin's explicit call
  assert.equal(rankQueue([job('J-0002'), job('J-0001', { source: 'SUGGESTED', expedite: true })], NOW, alt)[0]!.jobNo, 'J-0001');
});

test('same-formula grouping moves a job up one slot at most, never further', () => {
  const ranked = rankQueue([job('J-0001'), job('J-0002'), job('J-0003'), job('J-0004'), job('J-0005')], NOW, alt);
  const f: Record<string, string> = { 'J-0001': 'A', 'J-0002': 'B', 'J-0003': 'A', 'J-0004': 'C', 'J-0005': 'B' };
  const g = groupByFormula(ranked, (j) => f[j.jobNo] ?? null);
  assert.deepEqual(g.map((j) => j.jobNo), ['J-0001', 'J-0003', 'J-0002', 'J-0005', 'J-0004']);
  assert.match(g[1]!.why, /same formula as J-0001/);
  assert.deepEqual(g.map((j) => j.position), [1, 2, 3, 4, 5]);
  // no job sits more than one slot from where strict alternation put it
  const original = ranked.map((j) => j.jobNo);
  for (const [i, j] of g.entries()) assert.ok(Math.abs(original.indexOf(j.jobNo) - i) <= 1, `${j.jobNo} moved more than one slot`);
});

test('grouping leaves expedited, held, waiting and suggested jobs where the rule put them', () => {
  const ranked = rankQueue([job('J-0001', { expedite: true }), job('J-0002'), job('J-0003', { expedite: true })], NOW, alt);
  const g = groupByFormula(ranked, () => 'A');
  assert.deepEqual(g.map((j) => j.jobNo), ranked.map((j) => j.jobNo));
});
