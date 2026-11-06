/**
 * PROD-D-1 — the stock-cover arithmetic (plan 11, 12.9), pure. Plain arithmetic, no ML: a weighted
 * weekly rate, its variability, the trend, stock on hand + in production + in maceration, lead
 * time, and the planning.cover rule. Every answer carries its reasoning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weeklyBuckets, weightedRate, stdDev, trendOf, splitOutliers, parseCoverRule, suggestCover, type CoverInput, type DemandOrder,
} from '../planning/cover-model.js';

const NOW = new Date('2026-11-07T00:00:00Z');
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

/** `perWeek[i]` units in week i back (0 = the last 7 days). */
function orders(perWeek: number[]): DemandOrder[] {
  return perWeek.flatMap((q, i) => (q > 0 ? [{ orderRef: `O-${i}`, qty: q, at: ago(i * 7 + 1) }] : []));
}

function input(over: Partial<CoverInput> = {}): CoverInput {
  return {
    sku: 'AVT-50', now: NOW, orders: orders(Array(26).fill(38)),
    fgUnits: 40, inProductionUnits: 0, inMacerationUnits: 0, macerationReadyBy: null,
    lead: { stationDays: 2, qcDays: 1, macerationDays: 0 },
    blocked: [], rule: { mode: 'dynamic' }, ruleExplain: 'Rule 1: everything dynamic',
    ...over,
  };
}

test('weekly buckets: week 0 is the last 7 days, 26 weeks, older orders ignored', () => {
  const b = weeklyBuckets([{ orderRef: 'a', qty: 5, at: ago(1) }, { orderRef: 'b', qty: 7, at: ago(8) }, { orderRef: 'c', qty: 99, at: ago(200) }], NOW);
  assert.equal(b.length, 26);
  assert.equal(b[0], 5);
  assert.equal(b[1], 7);
  assert.equal(b.reduce((a, x) => a + x, 0), 12);
});

test('weighted rate: recent weeks count more than old ones', () => {
  const flat = Array(26).fill(10);
  assert.equal(weightedRate(flat), 10);
  const recent = [20, ...Array(25).fill(0)], old = [...Array(25).fill(0), 20];
  assert.ok(weightedRate(recent) > weightedRate(old));
});

test('variability: steady demand has none, lumpy demand has a lot', () => {
  assert.equal(stdDev(Array(26).fill(10)), 0);
  assert.ok(stdDev([50, 0, 50, 0, 50, 0]) > 20);
});

test('trend: last 13 weeks against the 13 before, as a bounded factor', () => {
  const rising = [...Array(13).fill(20), ...Array(13).fill(10)];
  const t = trendOf(rising);
  assert.equal(t.label, 'rising');
  assert.equal(t.factor, 1.25); // 2x is capped: one quarter cannot double the plan
  assert.equal(trendOf(Array(26).fill(10)).label, 'flat');
  assert.equal(trendOf([...Array(13).fill(5), ...Array(13).fill(10)]).label, 'falling');
  assert.equal(trendOf([...Array(13).fill(5), ...Array(13).fill(0)]).label, 'new');
});

test('outliers: a one-off bulk order is left out unless flagged recurring', () => {
  const base = orders(Array(10).fill(10));
  const bulk = { orderRef: 'BULK-1', qty: 500, at: ago(3) };
  const s = splitOutliers([...base, bulk]);
  assert.deepEqual(s.excluded.map((o) => o.orderRef), ['BULK-1']);
  const r = splitOutliers([...base, { ...bulk, recurring: true }]);
  assert.equal(r.excluded.length, 0);
  // too little history to call anything an outlier
  assert.equal(splitOutliers([{ orderRef: 'x', qty: 1, at: ago(1) }, { orderRef: 'y', qty: 900, at: ago(2) }]).excluded.length, 0);
});

test('rule: a value of the wrong shape is refused, never guessed', () => {
  assert.throws(() => parseCoverRule({ mode: 'weekly' }), /not a valid/);
  assert.throws(() => parseCoverRule({ mode: 'fixed' }), /coverWeeks/);
  assert.throws(() => parseCoverRule({ mode: 'dynamic', minUnits: 10, maxUnits: 5 }), /minUnits/);
  assert.deepEqual(parseCoverRule({ mode: 'fixed', coverWeeks: 8 }), { mode: 'fixed', coverWeeks: 8 });
});

test('no rule (planning.cover has none published): every product HOLDS and says so', () => {
  const s = suggestCover(input({ rule: null, ruleExplain: 'No rule matched and there is no default' }));
  assert.equal(s.status, 'HOLD');
  assert.equal(s.qty, 0);
  assert.match(s.why, /planning\.cover/);
});

test('dynamic: plan example, ~38/week, 40 on hand -> a positive suggestion with its reasoning', () => {
  const s = suggestCover(input());
  assert.equal(s.numbers.ratePerWeek, 38);
  // lead 3 days, no variability: 38 * 3/7 = 16.3 target, 40 on hand: covered
  assert.equal(s.status, 'NONE');
  assert.equal(s.qty, 0);
  assert.match(s.why, /^Covered/);
  const longer = suggestCover(input({ lead: { stationDays: 2, qcDays: 1, macerationDays: 45 } }));
  assert.equal(longer.status, 'SUGGEST');
  // 48 days lead: 38 * 48/7 = 260.57 -> 261 - 40 = 221
  assert.equal(longer.qty, 221);
  assert.match(longer.why, /^Make 221: sells ~38\/week/);
  assert.match(longer.why, /40 in stock/);
  assert.match(longer.why, /lead time 48 days/);
});

test('dynamic: lumpy demand gets a safety buffer sized to its variability', () => {
  const steady = suggestCover(input({ orders: orders(Array(26).fill(20)), fgUnits: 0, lead: { stationDays: 7, qcDays: 0, macerationDays: 0 } }));
  const lumpy = suggestCover(input({ orders: orders(Array(13).fill(0).flatMap(() => [40, 0])), fgUnits: 0, lead: { stationDays: 7, qcDays: 0, macerationDays: 0 } }));
  assert.equal(steady.numbers.bufferUnits, 0);
  assert.ok(lumpy.numbers.bufferUnits > 0);
  assert.ok(lumpy.qty > steady.qty);
  assert.match(lumpy.why, /buffer/);
});

test('stock counts finished goods, in production and in maceration (with its ready date)', () => {
  const s = suggestCover(input({ fgUnits: 40, inProductionUnits: 100, inMacerationUnits: 60, macerationReadyBy: '2026-11-20', lead: { stationDays: 2, qcDays: 1, macerationDays: 45 } }));
  assert.equal(s.qty, 261 - 200);
  assert.match(s.why, /60 in maceration ready 20 Nov/);
  assert.match(s.why, /100 in production/);
});

test('approved suggestions not yet started count as planned stock, so nothing is suggested twice', () => {
  const s = suggestCover(input({ plannedUnits: 221, lead: { stationDays: 2, qcDays: 1, macerationDays: 45 } }));
  assert.equal(s.status, 'NONE');
  assert.match(s.why, /221 approved and not started/);
});

test('fixed weeks (e.g. seasonal rule) and min/max caps', () => {
  const s = suggestCover(input({ rule: { mode: 'fixed', coverWeeks: 8 }, fgUnits: 0 }));
  assert.equal(s.qty, 38 * 8);
  assert.match(s.why, /cover 8 weeks/);
  const capped = suggestCover(input({ rule: { mode: 'fixed', coverWeeks: 8, maxUnits: 100 }, fgUnits: 0 }));
  assert.equal(capped.qty, 100);
  assert.match(capped.why, /capped at 100/);
  const floor = suggestCover(input({ rule: { mode: 'fixed', coverWeeks: 1, minUnits: 50 }, fgUnits: 0 }));
  assert.equal(floor.qty, 50);
});

test('rising trend raises the plan; the rule may add days (e.g. maceration)', () => {
  const rising = suggestCover(input({ orders: orders([...Array(13).fill(40), ...Array(13).fill(20)]), fgUnits: 0, lead: { stationDays: 7, qcDays: 0, macerationDays: 0 } }));
  assert.match(rising.why, /rising/);
  const flat = suggestCover(input({ orders: orders(Array(26).fill(rising.numbers.ratePerWeek)), fgUnits: 0, lead: { stationDays: 7, qcDays: 0, macerationDays: 0 } }));
  assert.ok(rising.qty > flat.qty);
  const extra = suggestCover(input({ rule: { mode: 'dynamic', extraDays: 14 }, fgUnits: 0 }));
  assert.equal(extra.numbers.leadDays, 17);
});

test('a product with an open QC reject or a lot hold is never suggested', () => {
  const s = suggestCover(input({ blocked: ['Batch OB-12 is REJECTED in QC'], lead: { stationDays: 2, qcDays: 1, macerationDays: 45 } }));
  assert.equal(s.status, 'BLOCKED');
  assert.equal(s.qty, 0);
  assert.match(s.why, /OB-12/);
});

test('locked by rule: no suggestion, and the screen says the rule locked it', () => {
  const s = suggestCover(input({ rule: { mode: 'dynamic', lock: true }, fgUnits: 0 }));
  assert.equal(s.status, 'LOCKED');
  assert.equal(s.qty, 0);
});

test('no station times measured: hold unless the rule names a lead time to use', () => {
  const s = suggestCover(input({ lead: { stationDays: null, qcDays: null, macerationDays: 0 } }));
  assert.equal(s.status, 'HOLD');
  assert.match(s.why, /No station times/);
  const d = suggestCover(input({ lead: { stationDays: null, qcDays: null, macerationDays: 10 }, rule: { mode: 'dynamic', defaultLeadDays: 4 }, fgUnits: 0 }));
  assert.equal(d.status, 'SUGGEST');
  assert.equal(d.numbers.leadDays, 14);
  assert.match(d.why, /4 days from the rule/);
});

test('no orders in 26 weeks: nothing to suggest, and it says why', () => {
  const s = suggestCover(input({ orders: [] }));
  assert.equal(s.status, 'NONE');
  assert.match(s.why, /No confirmed orders/);
});

test('excluded outliers are named in the reasoning', () => {
  const s = suggestCover(input({ orders: [...orders(Array(26).fill(10)), { orderRef: 'BULK-9', qty: 2000, at: ago(2) }], fgUnits: 0, lead: { stationDays: 7, qcDays: 0, macerationDays: 0 } }));
  assert.equal(s.numbers.ratePerWeek, 10);
  assert.match(s.why, /BULK-9/);
});
