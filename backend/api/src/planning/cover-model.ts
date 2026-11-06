/**
 * PROD-D-1 — stock cover per product (production-floor plan 11, 12.9), pure. Plain, explainable
 * arithmetic, no machine learning, no I/O, no clock (the caller passes `now`), so a suggestion can
 * be re-explained later from the inputs it recorded.
 *
 *   demand       confirmed ALEMBIC orders for the SKU over the last 26 weeks, in weekly buckets
 *                (week 0 = the 7 days before `now`). One-off bulk orders (more than 3x the median
 *                order, once there are at least 4 orders to judge by) are left out unless a planner
 *                flagged them recurring; what was left out is named in the reasoning.
 *   rate         weighted weekly rate: week i back has weight 26 - i, so recent weeks count more.
 *   variability  the standard deviation of the weekly buckets; lumpy demand needs more cover.
 *   trend        the last 13 weeks against the 13 before. The forecast is the weighted rate times
 *                that ratio bounded to [0.75, 1.25], so one quarter can move the plan by at most a
 *                quarter.
 *   lead time    measured station days + QC days + the formula's maceration days, plus any days the
 *                rule adds. Unmeasured station/QC time HOLDS unless the rule names defaultLeadDays.
 *   target       dynamic: forecast x lead weeks + buffer, buffer = z x sd x sqrt(lead weeks)
 *                (z from the rule, else 1.65, about 95% of weeks covered); fixed: forecast x weeks.
 *   suggestion   ceil(target) - (finished stock + in production + in maceration), floored at 0,
 *                then the rule's minUnits / maxUnits.
 *
 * The planning.cover policy ships with no default. A product the policy does not answer for HOLDS
 * and says so: it is never sized by a guess. A product with an open QC reject or a lot hold is
 * never suggested at all.
 */

export const WEEKS = 26;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const DEFAULT_Z = 1.65;

export interface DemandOrder { orderRef: string; qty: number; at: string; recurring?: boolean }

export interface CoverRule {
  mode: 'dynamic' | 'fixed';
  coverWeeks?: number;
  extraDays?: number;
  serviceZ?: number;
  minUnits?: number;
  maxUnits?: number;
  lock?: boolean;
  defaultLeadDays?: number;
}

export interface LeadTime { stationDays: number | null; qcDays: number | null; macerationDays: number }

export interface CoverInput {
  sku: string;
  now: Date;
  orders: DemandOrder[];
  fgUnits: number;
  inProductionUnits: number;
  inMacerationUnits: number;
  macerationReadyBy: string | null;
  lead: LeadTime;
  /** Reasons the product may not be suggested (open QC reject, lot hold). */
  blocked: string[];
  /** The planning.cover answer for this product, or null when the policy has none (HOLD). */
  rule: CoverRule | null;
  ruleExplain: string;
}

export type CoverStatus = 'SUGGEST' | 'NONE' | 'HOLD' | 'BLOCKED' | 'LOCKED';

export interface CoverNumbers {
  weeks: number[];
  weightedRate: number;
  ratePerWeek: number;
  forecastPerWeek: number;
  sdPerWeek: number;
  trend: TrendInfo;
  leadDays: number | null;
  bufferUnits: number;
  targetUnits: number;
  availableUnits: number;
  rawSuggestion: number;
  excludedOrders: string[];
}

export interface CoverSuggestion {
  sku: string;
  status: CoverStatus;
  qty: number;
  why: string;
  reasons: string[];
  numbers: CoverNumbers;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function weeklyBuckets(orders: DemandOrder[], now: Date, weeks = WEEKS): number[] {
  const b = Array<number>(weeks).fill(0);
  const t = now.getTime();
  for (const o of orders) {
    const at = Date.parse(o.at);
    if (!Number.isFinite(at) || at > t) continue;
    const i = Math.floor((t - at) / WEEK);
    if (i < weeks && Number.isFinite(o.qty) && o.qty > 0) b[i]! += o.qty;
  }
  return b;
}

export function weightedRate(buckets: number[]): number {
  const n = buckets.length;
  let num = 0, den = 0;
  buckets.forEach((q, i) => { const w = n - i; num += w * q; den += w; });
  return den ? num / den : 0;
}

export function stdDev(xs: number[]): number {
  if (!xs.length) return 0;
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

export interface TrendInfo { label: 'rising' | 'falling' | 'flat' | 'new'; ratio: number | null; factor: number }

export function trendOf(buckets: number[]): TrendInfo {
  const half = Math.floor(buckets.length / 2);
  const recent = buckets.slice(0, half).reduce((a, x) => a + x, 0);
  const before = buckets.slice(half, half * 2).reduce((a, x) => a + x, 0);
  if (before === 0) return { label: recent > 0 ? 'new' : 'flat', ratio: null, factor: 1 };
  const ratio = recent / before;
  const factor = Math.min(1.25, Math.max(0.75, ratio));
  return { label: ratio > 1.1 ? 'rising' : ratio < 0.9 ? 'falling' : 'flat', ratio: r1(ratio * 100) / 100, factor };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A one-off bulk order: more than 3x the median order, judged only with >= 4 orders. */
export function splitOutliers(orders: DemandOrder[]): { kept: DemandOrder[]; excluded: DemandOrder[] } {
  if (orders.length < 4) return { kept: orders, excluded: [] };
  const med = median(orders.map((o) => o.qty));
  const kept: DemandOrder[] = [], excluded: DemandOrder[] = [];
  for (const o of orders) (!o.recurring && med > 0 && o.qty > 3 * med ? excluded : kept).push(o);
  return { kept, excluded };
}

/** The planning.cover value, checked. Anything else is refused: the product holds, never guessed. */
export function parseCoverRule(v: unknown): CoverRule {
  const o = (v ?? {}) as Record<string, unknown>;
  const bad = (m: string): never => { throw new Error(`The planning.cover value is not a valid rule: ${m}`); };
  if (o.mode !== 'dynamic' && o.mode !== 'fixed') bad('mode must be "dynamic" or "fixed".');
  const out: CoverRule = { mode: o.mode as CoverRule['mode'] };
  if (o.mode === 'fixed') {
    if (!(typeof o.coverWeeks === 'number' && o.coverWeeks > 0 && o.coverWeeks <= 52)) bad('a fixed rule needs coverWeeks between 0 and 52.');
    out.coverWeeks = o.coverWeeks as number;
  }
  for (const k of ['extraDays', 'serviceZ', 'minUnits', 'maxUnits', 'defaultLeadDays'] as const) {
    if (o[k] == null) continue;
    if (!nonNeg(o[k])) bad(`${k} must be a number, 0 or more.`);
    out[k] = o[k] as number;
  }
  if (out.minUnits != null && out.maxUnits != null && out.minUnits > out.maxUnits) bad('minUnits is above maxUnits.');
  if (o.lock === true) out.lock = true;
  return out;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : iso;
}

export function suggestCover(i: CoverInput): CoverSuggestion {
  const { kept, excluded } = splitOutliers(i.orders);
  const weeks = weeklyBuckets(kept, i.now);
  const wr = weightedRate(weeks), sd = stdDev(weeks), trend = trendOf(weeks);
  const forecast = wr * trend.factor;
  const available = i.fgUnits + i.inProductionUnits + i.inMacerationUnits;
  const numbers: CoverNumbers = {
    weeks, weightedRate: wr, ratePerWeek: r1(wr), forecastPerWeek: r1(forecast), sdPerWeek: r1(sd), trend,
    leadDays: null, bufferUnits: 0, targetUnits: 0, availableUnits: available, rawSuggestion: 0,
    excludedOrders: excluded.map((o) => o.orderRef),
  };
  const reasons: string[] = [];
  const stockText = [`${i.fgUnits} in stock`,
    ...(i.inProductionUnits ? [`${i.inProductionUnits} in production`] : []),
    ...(i.inMacerationUnits ? [`${i.inMacerationUnits} in maceration${i.macerationReadyBy ? ` ready ${fmtDate(i.macerationReadyBy)}` : ''}`] : [])].join(', ');
  const out = (status: CoverStatus, qty: number, why: string): CoverSuggestion => ({ sku: i.sku, status, qty, why, reasons, numbers });

  if (i.blocked.length) {
    reasons.push(...i.blocked);
    return out('BLOCKED', 0, `Not suggested: ${i.blocked.join('; ')}.`);
  }
  if (!i.rule) {
    reasons.push(i.ruleExplain);
    return out('HOLD', 0, `Held: the planning.cover policy has no rule for this product and no default (${i.ruleExplain}). An admin publishes one on the Rules screen.`);
  }
  if (i.rule.lock) {
    reasons.push(i.ruleExplain);
    return out('LOCKED', 0, `Locked by the planning.cover rule (${i.ruleExplain}): no suggestion for this product.`);
  }
  if (!kept.length || wr === 0) {
    return out('NONE', 0, `No confirmed orders in the last ${WEEKS} weeks${excluded.length ? ` (left out as one-off: ${numbers.excludedOrders.join(', ')})` : ''}: nothing to suggest.`);
  }

  let leadDays: number;
  let leadText: string;
  if (i.lead.stationDays == null || i.lead.qcDays == null) {
    if (i.rule.defaultLeadDays == null) {
      reasons.push('Station or QC time not measured yet.');
      return out('HOLD', 0, `Held: No station times measured yet for this product's line and the planning.cover rule sets no defaultLeadDays, so the lead time is unknown.`);
    }
    leadDays = i.rule.defaultLeadDays + i.lead.macerationDays;
    leadText = `lead time ${r1(leadDays)} days (${i.rule.defaultLeadDays} days from the rule, nothing measured yet${i.lead.macerationDays ? ` + ${i.lead.macerationDays} maceration` : ''})`;
  } else {
    leadDays = i.lead.stationDays + i.lead.qcDays + i.lead.macerationDays;
    leadText = `lead time ${r1(leadDays)} days`;
  }
  if (i.rule.extraDays) { leadDays += i.rule.extraDays; leadText += ` + ${i.rule.extraDays} days from the rule`; }
  numbers.leadDays = r1(leadDays);
  const lw = leadDays / 7;

  let target: number, coverText: string;
  if (i.rule.mode === 'fixed') {
    target = forecast * i.rule.coverWeeks!;
    coverText = `cover ${i.rule.coverWeeks} weeks by rule`;
  } else {
    const z = i.rule.serviceZ ?? DEFAULT_Z;
    const buffer = z * sd * Math.sqrt(lw);
    numbers.bufferUnits = Math.max(0, Math.ceil(buffer - 1e-9));
    target = forecast * lw + buffer;
    coverText = `${leadText}, buffer ${forecast > 0 ? r1(buffer / forecast) : 0} weeks (variability ±${r1(sd)}/week${i.rule.serviceZ == null ? '' : `, z ${z}`})`;
  }
  numbers.targetUnits = Math.max(0, Math.ceil(target - 1e-9));
  let qty = Math.max(0, numbers.targetUnits - available);
  numbers.rawSuggestion = qty;
  const caps: string[] = [];
  if (qty > 0 && i.rule.minUnits != null && qty < i.rule.minUnits) { qty = i.rule.minUnits; caps.push(`raised to the minimum ${qty}`); }
  if (i.rule.maxUnits != null && qty > i.rule.maxUnits) { qty = i.rule.maxUnits; caps.push(`capped at ${qty}`); }

  const sells = `sells ~${r1(forecast)}/week${trend.label === 'flat' ? '' : ` and ${trend.label}`}`;
  const left = excluded.length ? `; left out as one-off: ${numbers.excludedOrders.join(', ')}` : '';
  reasons.push(i.ruleExplain);
  if (qty === 0) {
    return out('NONE', 0, `Covered: ${sells}, ${stockText}, target ${numbers.targetUnits} (${i.rule.mode === 'fixed' ? coverText + ', ' + leadText : coverText})${left}.`);
  }
  return out('SUGGEST', qty,
    `Make ${qty}: ${sells}, ${stockText}, ${i.rule.mode === 'fixed' ? `${coverText}, ${leadText}` : coverText}${caps.length ? `; ${caps.join(', ')}` : ''}${left}.`);
}
