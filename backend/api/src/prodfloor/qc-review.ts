/**
 * PROD-D-3 — the QC review decision rules (production-floor plan 12.7.4), pure.
 *
 * A batch whose failure came after the rework ceiling, or past the adjustment envelope, goes to
 * REVIEW (qc-decision.ts) instead of being rejected automatically. Two people decide it: a perfumer
 * (the formulator, who knows what the formula should smell like) and a vault_approver (who answers
 * for the formula). One proposes, the other confirms; the same person can never do both, and the
 * two signatures must be one of each.
 *
 *   REJECT     always possible.
 *   DOWNGRADE  sell the batch as a different grade or product, only when one is defined for this
 *              product (production.product_downgrade_target). Otherwise disabled, and the screen
 *              says why: nobody invents a grade at the moment of a failure.
 *   REBLEND    fold the batch into another batch, only when its formula allows it
 *              (production.formula_reblend_rule), and never more than the share the rule sets.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

export const PERM_READ = 'production:qc_review:read';
export const PERM_PERFUMER = 'production:qc_review:perfumer';
export const PERM_APPROVER = 'production:qc_review:approve';

export type Outcome = 'REJECT' | 'DOWNGRADE' | 'REBLEND';
export const OUTCOMES: readonly Outcome[] = ['REJECT', 'DOWNGRADE', 'REBLEND'];
export type Signature = 'PERFUMER' | 'APPROVER';

export interface ReviewContext {
  productId: string | null;
  productName: string | null;
  downgrade: { targetProductId: string | null; targetProductName: string | null; targetGrade: string | null } | null;
  formulaId: string | null;
  reblend: { allowed: boolean; maxShareBps: number | null } | null;
}
export interface OptionState { enabled: boolean; why: string }
export type ReviewOptions = Record<Outcome, OptionState>;

export function reviewOptions(c: ReviewContext): ReviewOptions {
  const name = c.productName ?? 'this product';
  let DOWNGRADE: OptionState;
  if (!c.productId) DOWNGRADE = { enabled: false, why: 'The batch\'s product is not known (no checkpoint set names it), so no downgrade target can apply.' };
  else if (!c.downgrade) DOWNGRADE = { enabled: false, why: `No downgrade target is defined for ${name}. A vault approver or admin defines one first (a grade or another product).` };
  else DOWNGRADE = { enabled: true, why: `May be sold as ${c.downgrade.targetGrade ?? c.downgrade.targetProductName ?? 'the defined product'}.` };
  let REBLEND: OptionState;
  if (!c.formulaId) REBLEND = { enabled: false, why: 'The batch\'s formula is not known (its production order names no plan item), so reblending cannot be checked.' };
  else if (!c.reblend || !c.reblend.allowed) REBLEND = { enabled: false, why: 'This formula does not allow reblending a failed batch into another (no reblend rule says it may).' };
  else REBLEND = { enabled: true, why: `The formula allows it, up to ${(c.reblend.maxShareBps ?? 0) / 100}% of the receiving batch.` };
  return { REJECT: { enabled: true, why: 'The batch stays quarantined, a CAPA opens and the stock is written off or returned.' }, DOWNGRADE, REBLEND };
}

/** Which signature this person gives. Holding both (the owner), they say which; default perfumer. */
export function signatureFor(perms: string[], wanted?: string | null): Signature {
  const p = perms.includes(PERM_PERFUMER), a = perms.includes(PERM_APPROVER);
  if (!p && !a) throw new ForbiddenException('A review decision is signed by a perfumer or a vault approver.');
  const w = wanted ? String(wanted).toUpperCase() : null;
  if (w === 'APPROVER') { if (!a) throw new ForbiddenException('You cannot sign as the vault approver.'); return 'APPROVER'; }
  if (w === 'PERFUMER') { if (!p) throw new ForbiddenException('You cannot sign as the perfumer.'); return 'PERFUMER'; }
  return p ? 'PERFUMER' : 'APPROVER';
}

export interface Proposal {
  outcome: Outcome;
  reason: string;
  targetProductId: string | null;
  targetGrade: string | null;
  reblendIntoOilBatchId: string | null;
  reblendShareBps: number | null;
}

export function checkProposal(outcome: unknown, body: Record<string, unknown>, o: ReviewOptions, c: ReviewContext): Proposal {
  const k = String(outcome ?? '').toUpperCase() as Outcome;
  if (!OUTCOMES.includes(k)) throw new BadRequestException('The outcome is reject, downgrade or reblend.');
  if (!o[k].enabled) throw new ConflictException(o[k].why);
  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new BadRequestException('Say why: the decision is kept with the batch\'s genealogy.');
  const out: Proposal = { outcome: k, reason, targetProductId: null, targetGrade: null, reblendIntoOilBatchId: null, reblendShareBps: null };
  if (k === 'DOWNGRADE') { out.targetProductId = c.downgrade!.targetProductId; out.targetGrade = c.downgrade!.targetGrade; }
  if (k === 'REBLEND') {
    const s = body.reblendShareBps;
    const max = c.reblend!.maxShareBps ?? 0;
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 1) throw new BadRequestException('Give the share of the receiving batch this batch will make up.');
    if (s > max) throw new ConflictException(`The formula allows at most ${max / 100}% of the receiving batch.`);
    out.reblendShareBps = s;
    out.reblendIntoOilBatchId = typeof body.reblendIntoOilBatchId === 'string' && body.reblendIntoOilBatchId ? body.reblendIntoOilBatchId : null;
  }
  return out;
}

export function checkConfirm(p: { proposedBy: string; proposedAs: Signature; status: string }, userId: string, sign: Signature): void {
  if (p.status !== 'PROPOSED') throw new ConflictException(`This decision is already ${p.status.toLowerCase()}.`);
  if (p.proposedBy === userId) throw new ForbiddenException('A different person must confirm: the one who proposed cannot.');
  if (p.proposedAs === sign) throw new ForbiddenException(p.proposedAs === 'PERFUMER' ? 'The perfumer proposed it: a vault approver must confirm.' : 'The vault approver proposed it: a perfumer must confirm.');
}
