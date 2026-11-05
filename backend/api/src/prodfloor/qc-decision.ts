/**
 * PROD-B-3 — the QC decision table (plan 7) with the 12.7 rework rules, pure.
 *
 *   all pass                                    APPROVE
 *   a never-rework defect (contamination, ...)  REJECT; FAULTY_RAW_LOT also holds the raw lot
 *   a failed critical checkpoint                REJECT + CAPA
 *   instrument doubt                            HOLD_RETEST once; a fail after the retest rejects
 *   same checkpoint failed in an earlier round  HOLD_CAPA: repeating a fix is a process problem
 *   reworks already at the ceiling (3rd fail)   REVIEW by perfumer + vault_approver, never auto-reject
 *   adjustment envelope used up                 REVIEW: past it the batch is a different formula
 *   otherwise, a correctable defect             REWORK
 *
 * The server evaluates every result against the pinned checkpoint set: a RANGE is judged from the
 * value, not from a pass flag the client sent. Every round, including after a rework, must carry a
 * result for every checkpoint on the set (12.7.6 full re-QC).
 */
import { BadRequestException } from '@nestjs/common';

export interface Checkpoint {
  id: string;
  name: string;
  checkType: 'PASS_FAIL' | 'RANGE' | 'REFERENCE';
  min?: number | null;
  max?: number | null;
  critical: boolean;
  photoRequired?: boolean;
}
export interface QcResult { checkpointId: string; pass?: boolean; value?: number | null; note?: string; photoRef?: string }
export interface ReworkPolicy { maxReworks: number; envelopeBps: number; differentInspector: boolean }
export interface QcHistory {
  reworks: number;
  failedCheckpointsByRound: string[][];
  retests: number;
  cumulativeAdjustmentMg: number;
  lastDecision?: string | null;
}
export interface QcInput {
  checkpoints: Checkpoint[];
  results: QcResult[];
  defectType?: string | null;
  instrumentDoubt?: boolean;
  policy: ReworkPolicy;
  history: QcHistory;
  batchMg: number;
}
export type QcDecisionCode = 'APPROVE' | 'REWORK' | 'HOLD_RETEST' | 'REJECT' | 'REVIEW' | 'HOLD_CAPA';
export interface QcDecision { decision: QcDecisionCode; failed: string[]; reasons: string[]; openCapa: boolean; lotHold: boolean }

/** 12.7.1: rework would hide the cause. */
export const NEVER_REWORK = ['CONTAMINATION', 'FOREIGN_MATTER', 'WRONG_ODOUR', 'MICROBIAL', 'STABILITY', 'FORMULA_MISMATCH', 'FAULTY_RAW_LOT'] as const;
/** 12.7.2: the defect types a rework can correct. */
export const CORRECTABLE = ['STRENGTH', 'CONCENTRATION', 'COLOUR', 'CLARITY', 'DENSITY', 'REFRACTIVE_INDEX'] as const;
export const DEFECT_TYPES: readonly string[] = [...NEVER_REWORK, ...CORRECTABLE];

export function parseReworkPolicy(v: unknown): ReworkPolicy {
  const o = (v ?? {}) as Record<string, unknown>;
  const m = o.maxReworks, e = o.envelopeBps;
  if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > 10) throw new BadRequestException('The qc.rework policy has no valid rework ceiling, so QC is held.');
  if (typeof e !== 'number' || !Number.isInteger(e) || e < 0 || e > 10000) throw new BadRequestException('The qc.rework policy has no valid adjustment envelope, so QC is held.');
  return { maxReworks: m, envelopeBps: e, differentInspector: o.differentInspector === true };
}

/** Returns the failed checkpoint ids; throws when a checkpoint lacks a usable result. */
export function validateResults(cps: Checkpoint[], results: QcResult[]): string[] {
  const byId = new Map(results.map((r) => [r.checkpointId, r]));
  for (const r of results) if (!cps.some((c) => c.id === r.checkpointId)) throw new BadRequestException(`A result is for a checkpoint that is not on this spec (${r.checkpointId}).`);
  const failed: string[] = [];
  for (const c of cps) {
    const r = byId.get(c.id);
    if (!r) throw new BadRequestException(`Every checkpoint needs a result, after a rework too: "${c.name}" has none.`);
    if (c.photoRequired && !(typeof r.photoRef === 'string' && r.photoRef.trim())) throw new BadRequestException(`"${c.name}" needs a photo.`);
    if (c.checkType === 'RANGE') {
      const v = r.value;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequestException(`"${c.name}" needs a measured value.`);
      if (v < Number(c.min) || v > Number(c.max)) failed.push(c.id);
    } else {
      if (typeof r.pass !== 'boolean') throw new BadRequestException(`"${c.name}" needs pass or fail.`);
      if (!r.pass) failed.push(c.id);
    }
  }
  return failed;
}

export function decideQc(i: QcInput): QcDecision {
  const failed = validateResults(i.checkpoints, i.results);
  const out = (decision: QcDecisionCode, reasons: string[], extra: Partial<QcDecision> = {}): QcDecision =>
    ({ decision, failed, reasons, openCapa: false, lotHold: false, ...extra });
  if (!failed.length) return out('APPROVE', ['All checkpoints pass.']);

  const names = failed.map((id) => i.checkpoints.find((c) => c.id === id)!.name).join(', ');
  const t = String(i.defectType ?? '').toUpperCase();
  if (!t) throw new BadRequestException(`Failed: ${names}. Choose the defect type; the rule decides from it.`);
  if (!DEFECT_TYPES.includes(t)) throw new BadRequestException(`Unknown defect type "${t}".`);

  if ((NEVER_REWORK as readonly string[]).includes(t)) {
    return out('REJECT', [`${t} is never reworked: rework would hide the cause.`], { openCapa: true, lotHold: t === 'FAULTY_RAW_LOT' });
  }
  const critical = failed.filter((id) => i.checkpoints.find((c) => c.id === id)!.critical);
  if (critical.length) return out('REJECT', [`Critical checkpoint failed: ${critical.map((id) => i.checkpoints.find((c) => c.id === id)!.name).join(', ')}.`], { openCapa: true });

  const h = i.history;
  if (h.retests >= 1 && (i.instrumentDoubt || h.lastDecision === 'HOLD_RETEST')) {
    return out('REJECT', ['Failed again after the one allowed retest: two fails reject.'], { openCapa: true });
  }
  if (i.instrumentDoubt) return out('HOLD_RETEST', ['Instrument doubt: quarantined for a retest of a fresh sample by a second QC person.']);

  const before = new Set(h.failedCheckpointsByRound.flat());
  const repeat = failed.filter((id) => before.has(id));
  if (repeat.length && h.reworks >= 1) {
    return out('HOLD_CAPA', [`Same checkpoint failed again after a rework (${repeat.map((id) => i.checkpoints.find((c) => c.id === id)!.name).join(', ')}): batch held, CAPA opened.`], { openCapa: true });
  }
  if (h.reworks >= i.policy.maxReworks) {
    return out('REVIEW', [`Failure after ${h.reworks} rework(s), the ceiling is ${i.policy.maxReworks}: perfumer + vault_approver review (reject, downgrade or reblend).`]);
  }
  const envelopeMg = Math.floor((i.batchMg * i.policy.envelopeBps) / 10000);
  if (h.cumulativeAdjustmentMg >= envelopeMg) {
    return out('REVIEW', [`Adjustment envelope used: ${h.cumulativeAdjustmentMg} of ${envelopeMg} mg. Past it the batch is a different formula: vault_approver decision.`]);
  }
  return out('REWORK', [`${t} on ${names} is correctable: back to the mixer, then a full re-QC on every checkpoint.`]);
}
