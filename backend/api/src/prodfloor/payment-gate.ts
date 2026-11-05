/**
 * PROD-B-3 — the 12.8 payment release gate, pure. Before this an advance was written to
 * procurement.po_advance_payment as PAID the moment anyone recorded it: no approval, no bank
 * reference, nothing stopping more going out than the goods were worth.
 *
 * Terms come from the `procurement.payment_terms` policy:
 *   ADVANCE_BALANCE  advanceBps of PO value once the PO is approved, the balance against GRN
 *   AGAINST_GRN      only what was accepted (rejected and short quantities are never in it)
 *   CREDIT           against GRN, with a due date `days` from the GRN or invoice date
 *
 * The invariant in every mode: what is requested + approved + released never exceeds
 *   max(accepted value, the advance allowance), so overpayment cannot be recorded.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';

export type Terms =
  | { mode: 'ADVANCE_BALANCE'; advanceBps: number }
  | { mode: 'AGAINST_GRN' }
  | { mode: 'CREDIT'; days: number; from: 'GRN' | 'INVOICE' };
export type ReleaseKind = 'ADVANCE' | 'BALANCE';

export interface PoMoney {
  poValuePaise: number;
  poApproved: boolean;
  acceptedValuePaise: number;
  /** Requested, approved or released (never REFUSED), per kind. */
  committed: Record<ReleaseKind, number>;
}

export function parseTerms(v: unknown): Terms {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.mode === 'AGAINST_GRN') return { mode: 'AGAINST_GRN' };
  if (o.mode === 'ADVANCE_BALANCE') {
    const b = o.advanceBps;
    if (typeof b !== 'number' || !Number.isInteger(b) || b <= 0 || b > 10000) throw new BadRequestException('Payment terms: the advance must be a whole number of basis points, 1 to 10000.');
    return { mode: 'ADVANCE_BALANCE', advanceBps: b };
  }
  if (o.mode === 'CREDIT') {
    const d = o.days;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 365) throw new BadRequestException('Payment terms: credit days must be 0 to 365.');
    if (o.from !== 'GRN' && o.from !== 'INVOICE') throw new BadRequestException('Payment terms: credit runs from GRN or INVOICE.');
    return { mode: 'CREDIT', days: d, from: o.from };
  }
  throw new BadRequestException('Payment terms are not set to a known mode, so the payment is held.');
}

export function advanceAllowance(t: Terms, s: PoMoney): number {
  if (t.mode !== 'ADVANCE_BALANCE' || !s.poApproved) return 0;
  return Math.floor((s.poValuePaise * t.advanceBps) / 10000);
}

/** The most that may still be requested of this kind, in paise. */
export function releasable(t: Terms, kind: ReleaseKind, s: PoMoney): number {
  const total = s.committed.ADVANCE + s.committed.BALANCE;
  if (kind === 'ADVANCE') {
    const allowance = advanceAllowance(t, s);
    return Math.max(0, allowance - s.committed.ADVANCE);
  }
  // The balance tops payments up to what was accepted; an advance already over that is never topped up.
  return Math.max(0, s.acceptedValuePaise - total);
}

export function checkMakerChecker(step: 'approve' | 'release', p: { actor: string; requestedBy: string; poCreatedBy: string | null }): void {
  if (p.poCreatedBy && p.actor === p.poCreatedBy) throw new ForbiddenException(`You raised this purchase order, so you cannot ${step} a payment against it. Another person must.`);
  if (step === 'approve' && p.actor === p.requestedBy) throw new ForbiddenException('You requested this payment, so you cannot approve it. Another person must.');
}

function addDays(ymd: string, days: number): string {
  const d = new Date(ymd.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dueDate(t: Terms, at: { grnDate: string | null; invoiceDate: string | null }): string | null {
  if (t.mode !== 'CREDIT') return null;
  const from = t.from === 'GRN' ? at.grnDate : at.invoiceDate;
  return from ? addDays(from, t.days) : null;
}
