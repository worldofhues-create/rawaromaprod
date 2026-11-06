/**
 * PROD-D-3 — the QC review decision (plan 12.7.4), pure: a batch whose third failure sent it to
 * REVIEW gets one of three outcomes from a perfumer and a vault_approver (two people, one of each):
 * reject; downgrade only when a target grade or product is defined; reblend only when the formula
 * allows it. A disabled outcome says why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewOptions, signatureFor, checkProposal, checkConfirm, PERM_PERFUMER, PERM_APPROVER } from '../prodfloor/qc-review.js';

const none = { productId: 'p1', productName: 'Aventus-type accord', downgrade: null, formulaId: 'f1', reblend: null };

test('reject is always open; downgrade and reblend are disabled with the reason when nothing is defined', () => {
  const o = reviewOptions(none);
  assert.equal(o.REJECT.enabled, true);
  assert.equal(o.DOWNGRADE.enabled, false);
  assert.match(o.DOWNGRADE.why, /No downgrade target is defined for Aventus-type accord/);
  assert.equal(o.REBLEND.enabled, false);
  assert.match(o.REBLEND.why, /formula does not allow reblending/);
});

test('downgrade opens when a target grade or product is defined; reblend when the formula allows it', () => {
  const o = reviewOptions({ ...none, downgrade: { targetProductId: null, targetProductName: null, targetGrade: 'Industrial grade' }, reblend: { allowed: true, maxShareBps: 1000 } });
  assert.equal(o.DOWNGRADE.enabled, true);
  assert.match(o.DOWNGRADE.why, /Industrial grade/);
  assert.equal(o.REBLEND.enabled, true);
  assert.match(o.REBLEND.why, /up to 10%/);
  const no = reviewOptions({ ...none, reblend: { allowed: false, maxShareBps: null } });
  assert.equal(no.REBLEND.enabled, false);
  assert.match(no.REBLEND.why, /does not allow/);
});

test('unknown product or formula: those outcomes are disabled, never assumed', () => {
  const o = reviewOptions({ productId: null, productName: null, downgrade: null, formulaId: null, reblend: null });
  assert.match(o.DOWNGRADE.why, /product is not known/);
  assert.match(o.REBLEND.why, /formula is not known/);
});

test('signature: perfumer or approver from the permissions held; neither is refused', () => {
  assert.equal(signatureFor([PERM_PERFUMER]), 'PERFUMER');
  assert.equal(signatureFor([PERM_APPROVER]), 'APPROVER');
  assert.equal(signatureFor([PERM_PERFUMER, PERM_APPROVER], 'APPROVER'), 'APPROVER');
  assert.equal(signatureFor([PERM_PERFUMER, PERM_APPROVER]), 'PERFUMER');
  assert.throws(() => signatureFor(['production:qc_review:read']), /perfumer or a vault approver/);
  assert.throws(() => signatureFor([PERM_PERFUMER], 'APPROVER'), /cannot sign as/);
});

test('proposal: a disabled outcome is refused with its reason; a reason is required; reblend share within the rule', () => {
  const o = reviewOptions(none);
  assert.throws(() => checkProposal('DOWNGRADE', { reason: 'x' }, o, none), /No downgrade target/);
  assert.throws(() => checkProposal('REJECT', { reason: ' ' }, o, none), /Say why/);
  assert.throws(() => checkProposal('MAYBE', { reason: 'x' }, o, none), /reject, downgrade or reblend/);
  const ctx = { ...none, reblend: { allowed: true, maxShareBps: 1000 } };
  const ok = reviewOptions(ctx);
  assert.throws(() => checkProposal('REBLEND', { reason: 'x', reblendShareBps: 2000 }, ok, ctx), /at most 10%/);
  assert.deepEqual(checkProposal('REBLEND', { reason: 'fold in', reblendShareBps: 500 }, ok, ctx), { outcome: 'REBLEND', reason: 'fold in', reblendShareBps: 500, reblendIntoOilBatchId: null, targetProductId: null, targetGrade: null });
});

test('confirm: a different person holding the other signature; the proposer cannot confirm their own', () => {
  const p = { proposedBy: 'u1', proposedAs: 'PERFUMER' as const, status: 'PROPOSED' };
  assert.throws(() => checkConfirm(p, 'u1', 'APPROVER'), /different person/);
  assert.throws(() => checkConfirm(p, 'u2', 'PERFUMER'), /vault approver must confirm/);
  assert.doesNotThrow(() => checkConfirm(p, 'u2', 'APPROVER'));
  assert.throws(() => checkConfirm({ ...p, status: 'CONFIRMED' }, 'u2', 'APPROVER'), /already/);
});
