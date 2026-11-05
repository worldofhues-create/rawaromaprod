/**
 * PROD-B-1 — lane B reads policy through lane A's PolicyService (backend/api/src/policy, PROD-A-1).
 * This file only adapts the stored values to what lane B's rules need, and fails closed: a value of
 * the wrong shape is a 409 HOLD, never a guessed threshold. PolicyUnresolved (no rule, no default:
 * payment terms ship that way) is also a HOLD.
 */
import { ConflictException } from '@nestjs/common';
import { PolicyService, PolicyUnresolved, type PolicyResult } from '../policy/policy.service.js';
import type { ShortfallPolicy } from './receiving-rule.js';
import type { ReworkPolicy } from './qc-decision.js';

export { PolicyService, PolicyUnresolved };
export type PolicyPort = Pick<PolicyService, 'evaluate'>;

export async function evaluateOrHold(p: PolicyPort, key: string, ctx: Record<string, unknown>): Promise<PolicyResult> {
  try {
    return await p.evaluate(key, ctx);
  } catch (e) {
    if (e instanceof PolicyUnresolved) throw new ConflictException(`${e.message} (${e.explain})`);
    throw e;
  }
}

function pctToBps(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
}

/** receiving.shortfall: lane A stores { basis: 'po'|'line', shortPct, extraPct }. */
export function shortfallFrom(v: unknown): ShortfallPolicy {
  const o = (v ?? {}) as Record<string, unknown>;
  const basis = String(o.basis ?? o.scope ?? '').toUpperCase();
  const s = o.shortRejectBps ?? pctToBps(o.shortPct), e = o.extraHoldBps ?? pctToBps(o.extraPct);
  if ((basis !== 'PO' && basis !== 'LINE') || typeof s !== 'number' || s > 10000 || typeof e !== 'number') {
    throw new ConflictException('The receiving.shortfall policy value is not a valid rule, so this delivery is held. Ask an admin to fix it on the Rules screen.');
  }
  return { scope: basis, shortRejectBps: s, extraHoldBps: e };
}

/** The 12.7.3 envelope the plan gives as its example (5% of batch weight), used only when the
 *  qc.rework rule does not set one; the round records which applied. */
export const DEFAULT_ENVELOPE_BPS = 500;

/** qc.rework: lane A stores { maxReworks } and may add envelopePct / differentInspector. */
export function reworkFrom(v: unknown): ReworkPolicy & { envelopeDefaulted: boolean } {
  const o = (v ?? {}) as Record<string, unknown>;
  const m = o.maxReworks;
  if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > 10) throw new ConflictException('The qc.rework policy has no valid rework ceiling, so QC is held.');
  const env = (o.envelopeBps as number | undefined) ?? pctToBps(o.envelopePct);
  if (env != null && (typeof env !== 'number' || env > 10000)) throw new ConflictException('The qc.rework envelope is not valid, so QC is held.');
  return { maxReworks: m, envelopeBps: env ?? DEFAULT_ENVELOPE_BPS, differentInspector: o.differentInspector === true, envelopeDefaulted: env == null };
}
