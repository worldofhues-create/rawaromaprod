/**
 * PROD-B-2 — the material audit and the 12.1 shortfall/extra rule, as one pure function.
 *
 * Plan section 4 and 12.1. The auditor ticks every checklist item on every PO line (or gives a
 * reason); the system then proposes a decision per line from the `receiving.shortfall` policy:
 *
 *   scope PO (default)   short and extra are measured on the PO as a whole, per material unit
 *                        (mg lines never sum with counted lines). PO short >= shortRejectBps
 *                        rejects the line(s) that are short and accepts the rest.
 *   scope LINE           the same thresholds, measured on each line.
 *   extra                above extraHoldBps the excess is held for purchase approval; at or under
 *                        it the excess is accepted.
 *   cumulative           several deliveries against one PO: extra is judged on the cumulative total
 *                        every time (goods already here cannot be un-received), shortness only at
 *                        PO close (`finalDelivery`). Before that a short line is PENDING_BALANCE.
 *   damaged              never accepted, and counts as short when judging the percentage.
 *   label / expiry       a label that does not match, or an expired lot, rejects the line. We never
 *                        relabel on the floor.
 *   override             a partial accept/reject splits this delivery exactly, with a reason; the
 *                        service restricts it to admin/owner (12.0) and the line shows OVERRIDDEN.
 *
 * Quantities are integer base units: mg for mass, units for counted goods. `priorReceivedBase` is
 * what earlier deliveries already ACCEPTED on the line. Money is integer paise, rounded once.
 */
import { BadRequestException } from '@nestjs/common';

export type BaseUnit = 'mg' | 'unit';
export interface CheckItem { ok: boolean; reason?: string }
export const CHECK_KEYS = ['countWeight', 'sealIntact', 'labelMatches', 'coaPresent', 'expiryOk', 'noDamage'] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];
export type Checklist = Record<CheckKey, CheckItem>;

export const CHECK_LABELS: Record<CheckKey, string> = {
  countWeight: 'Count / weight',
  sealIntact: 'Seal intact',
  labelMatches: 'Label matches',
  coaPresent: 'COA present',
  expiryOk: 'Expiry',
  noDamage: 'No damage',
};

export interface ShortfallPolicy { scope: 'PO' | 'LINE'; shortRejectBps: number; extraHoldBps: number }

export interface AuditLineInput {
  poItemId: string;
  unit: BaseUnit;
  orderedBase: number;
  priorReceivedBase: number;
  receivedBase: number;
  damagedBase: number;
  checks: Checklist;
  override?: { acceptedBase: number; rejectedBase: number; reason: string };
}

export type LineDecision = 'ACCEPT' | 'ACCEPT_SHORT' | 'PENDING_BALANCE' | 'REJECT_LINE' | 'EXCESS_HELD';

export interface AuditLineResult {
  poItemId: string;
  unit: BaseUnit;
  decision: LineDecision;
  acceptedBase: number;
  rejectedBase: number;
  excessHeldBase: number;
  /** Ordered but never delivered (cumulative), whatever was decided about what did arrive. */
  shortBase: number;
  cumulativeReceivedBase: number;
  overridden: boolean;
  overrideReason: string | null;
  explain: string;
}

export interface ReceivingDecision {
  lines: AuditLineResult[];
  /** PO-wide short in basis points per unit (negative = extra). */
  poShortBps: Partial<Record<BaseUnit, number>>;
}

const MASS: Record<string, number> = { KG: 1_000_000, KGS: 1_000_000, G: 1_000, GM: 1_000, GMS: 1_000, GRAM: 1_000, GRAMS: 1_000, MG: 1 };
const COUNT = new Set(['NOS', 'NO', 'PCS', 'PC', 'EA', 'EACH', 'UNIT', 'UNITS', 'BOX', 'DRUM', 'CAN']);

/** A PO quantity in its unit -> integer base units; null when the unit cannot be audited (e.g. litres
 *  without a density), so the caller holds rather than guessing a conversion. */
export function toBaseUnits(qty: number | string, uomCode: string | null | undefined): { unit: BaseUnit; base: number; factor: number } | null {
  const code = String(uomCode ?? '').trim().toUpperCase();
  const n = Number(qty);
  if (!code || !Number.isFinite(n) || n < 0) return null;
  if (code in MASS) { const factor = MASS[code]!; return { unit: 'mg', base: Math.round(n * factor), factor }; }
  if (COUNT.has(code)) return { unit: 'unit', base: Math.round(n), factor: 1 };
  return null;
}

function bad(msg: string): never { throw new BadRequestException(msg); }
function int(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) bad(`${what} must be a whole number of base units, 0 or more.`);
  return n;
}
function bps(part: number, whole: number): number { return whole > 0 ? Math.round((part * 10000) / whole) : 0; }
function pct(b: number): string { return (b / 100).toFixed(b % 100 === 0 ? 0 : 2) + '%'; }

export function validateChecklist(c: unknown, where: string): Checklist {
  if (!c || typeof c !== 'object') bad(`${where}: the checklist is missing.`);
  const o = c as Record<string, unknown>;
  for (const k of CHECK_KEYS) {
    const v = o[k] as CheckItem | undefined;
    if (!v || typeof v.ok !== 'boolean') bad(`${where}: "${CHECK_LABELS[k]}" (${k}) is neither ticked nor marked.`);
    if (!v.ok && !(typeof v.reason === 'string' && v.reason.trim())) bad(`${where}: "${CHECK_LABELS[k]}" is marked not OK without a reason.`);
  }
  return Object.fromEntries(CHECK_KEYS.map((k) => {
    const v = o[k] as CheckItem;
    return [k, v.ok ? { ok: true } : { ok: false, reason: String(v.reason).trim() }];
  })) as Checklist;
}

export function decideReceiving(input: AuditLineInput[], policy: ShortfallPolicy, opts: { finalDelivery: boolean }): ReceivingDecision {
  if (!input.length) bad('A delivery needs at least one PO line.');
  if (policy.scope !== 'PO' && policy.scope !== 'LINE') bad('The shortfall policy scope must be PO or LINE.');
  const lines = input.map((l, i) => {
    const where = `Line ${i + 1}`;
    const ordered = int(l.orderedBase, `${where} ordered`);
    const prior = int(l.priorReceivedBase, `${where} earlier deliveries`);
    const received = int(l.receivedBase, `${where} received`);
    const damaged = int(l.damagedBase, `${where} damaged`);
    if (damaged > received) bad(`${where}: damaged cannot be more than received.`);
    return { l, ordered, prior, received, damaged, checks: validateChecklist(l.checks, where) };
  });

  // PO-wide totals per unit, on the effective (undamaged) cumulative quantity.
  const totals: Partial<Record<BaseUnit, { ordered: number; effective: number }>> = {};
  for (const x of lines) {
    const t = (totals[x.l.unit] ??= { ordered: 0, effective: 0 });
    t.ordered += x.ordered;
    t.effective += x.prior + x.received - x.damaged;
  }
  const poShortBps: Partial<Record<BaseUnit, number>> = {};
  for (const u of Object.keys(totals) as BaseUnit[]) poShortBps[u] = bps(totals[u]!.ordered - totals[u]!.effective, totals[u]!.ordered);

  const out = lines.map(({ l, ordered, prior, received, damaged, checks }): AuditLineResult => {
    const effective = prior + received - damaged;
    const lineShortBps = bps(ordered - effective, ordered);
    const measured = policy.scope === 'PO' ? poShortBps[l.unit]! : lineShortBps;
    const where = policy.scope === 'PO' ? 'the PO' : 'this line';
    const shortBase = Math.max(0, ordered - prior - received);
    const base = { poItemId: l.poItemId, unit: l.unit, shortBase, cumulativeReceivedBase: prior + received, overridden: false, overrideReason: null };

    if (l.override) {
      const a = int(l.override.acceptedBase, 'Override accepted');
      const r = int(l.override.rejectedBase, 'Override rejected');
      if (a + r !== received) bad(`Line ${l.poItemId}: accepted and rejected must add up to the ${received} received.`);
      if (!(typeof l.override.reason === 'string' && l.override.reason.trim())) bad('An override needs a reason.');
      if (r < damaged) bad('An override cannot accept damaged quantity.');
      return { ...base, decision: r > 0 ? (a > 0 ? 'ACCEPT_SHORT' : 'REJECT_LINE') : 'ACCEPT', acceptedBase: a, rejectedBase: r, excessHeldBase: 0,
        overridden: true, overrideReason: l.override.reason.trim(), explain: `OVERRIDDEN: ${l.override.reason.trim()}` };
    }

    const reject = (why: string): AuditLineResult => ({ ...base, decision: 'REJECT_LINE', acceptedBase: 0, rejectedBase: received, excessHeldBase: 0, explain: why });
    if (!checks.labelMatches.ok) return reject(`Rejected: the label does not match (${checks.labelMatches.reason}). Never relabelled on the floor.`);
    if (!checks.expiryOk.ok) return reject(`Rejected: expiry (${checks.expiryOk.reason}).`);

    const extra = effective - ordered;
    if (extra > 0) {
      const extraBps = policy.scope === 'PO' ? -poShortBps[l.unit]! : bps(extra, ordered);
      if (extraBps > policy.extraHoldBps) {
        const held = Math.min(extra, received - damaged);
        return { ...base, decision: 'EXCESS_HELD', acceptedBase: received - damaged - held, rejectedBase: damaged, excessHeldBase: held,
          explain: `Extra ${pct(extraBps)} on ${where} is over the ${pct(policy.extraHoldBps)} tolerance: the excess is held for purchase approval.` };
      }
      return { ...base, decision: 'ACCEPT', acceptedBase: received - damaged, rejectedBase: damaged, excessHeldBase: 0,
        explain: `Extra ${pct(Math.max(0, extraBps))} on ${where} is within the ${pct(policy.extraHoldBps)} tolerance.` };
    }
    if (effective < ordered) {
      if (!opts.finalDelivery) {
        return { ...base, decision: 'PENDING_BALANCE', acceptedBase: received - damaged, rejectedBase: damaged, excessHeldBase: 0,
          explain: `Part delivery: ${pct(lineShortBps)} of the line still to come. Shortness is judged on the total at PO close.` };
      }
      if (measured >= policy.shortRejectBps) {
        return reject(`Short ${pct(measured)} on ${where} at PO close, at or over the ${pct(policy.shortRejectBps)} limit: the short line is rejected.`);
      }
      return { ...base, decision: 'ACCEPT_SHORT', acceptedBase: received - damaged, rejectedBase: damaged, excessHeldBase: 0,
        explain: `Short ${pct(measured)} on ${where}, under the ${pct(policy.shortRejectBps)} limit: accepted, deficit recorded.` };
    }
    return { ...base, decision: 'ACCEPT', acceptedBase: received - damaged, rejectedBase: damaged, excessHeldBase: 0,
      explain: damaged ? 'Accepted; the damaged quantity is rejected.' : 'Accepted in full.' };
  });
  return { lines: out, poShortBps };
}

/** Debit-note lines: rejected quantity, plus the undelivered shortfall once the PO is closed (a part
 *  delivery's balance is still expected, so it is not debited). Valued once: base x paise / factor. */
export function debitNoteLines(
  lines: AuditLineResult[],
  rates: Record<string, { ratePaise: number; factor: number }>,
  opts: { finalDelivery: boolean } = { finalDelivery: true },
): Array<{ poItemId: string; rejectedBase: number; shortBase: number; amountPaise: number }> {
  const out: Array<{ poItemId: string; rejectedBase: number; shortBase: number; amountPaise: number }> = [];
  for (const l of lines) {
    const rate = rates[l.poItemId];
    if (!rate) continue;
    const short = opts.finalDelivery && l.decision !== 'PENDING_BALANCE' ? l.shortBase : 0;
    const qty = l.rejectedBase + short;
    if (qty <= 0) continue;
    const amount = Number((BigInt(qty) * BigInt(rate.ratePaise) * 2n + BigInt(rate.factor)) / (BigInt(rate.factor) * 2n));
    if (amount > 0) out.push({ poItemId: l.poItemId, rejectedBase: l.rejectedBase, shortBase: short, amountPaise: amount });
  }
  return out;
}
