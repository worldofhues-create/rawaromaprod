/**
 * PROD-B-3 — the 12.8 payment release gate and the 7 / 12.7 QC decision table, as pure functions
 * (backend/api/src/prodfloor/payment-gate.ts, qc-decision.ts). Money in integer paise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTerms, releasable, checkMakerChecker, dueDate } from '../prodfloor/payment-gate.js';
import { decideQc, NEVER_REWORK, validateResults, type QcInput, type Checkpoint } from '../prodfloor/qc-decision.js';

/* ── payment gate ─────────────────────────────────────────────────────────────── */

const PO = { poValuePaise: 1_000_000_00, poApproved: true, acceptedValuePaise: 0, committed: { ADVANCE: 0, BALANCE: 0 } };

test('terms: the three modes parse; anything else holds', () => {
  assert.deepEqual(parseTerms({ mode: 'ADVANCE_BALANCE', advanceBps: 3000 }), { mode: 'ADVANCE_BALANCE', advanceBps: 3000 });
  assert.deepEqual(parseTerms({ mode: 'AGAINST_GRN' }), { mode: 'AGAINST_GRN' });
  assert.deepEqual(parseTerms({ mode: 'CREDIT', days: 30, from: 'GRN' }), { mode: 'CREDIT', days: 30, from: 'GRN' });
  assert.throws(() => parseTerms({ mode: 'WHATEVER' }), /terms/i);
  assert.throws(() => parseTerms({ mode: 'ADVANCE_BALANCE', advanceBps: 12000 }), /advance/i);
});

test('advance: up to the advance % of PO value, only once the PO is approved, only on advance terms', () => {
  const t = parseTerms({ mode: 'ADVANCE_BALANCE', advanceBps: 3000 });
  assert.equal(releasable(t, 'ADVANCE', PO), 300_000_00);
  assert.equal(releasable(t, 'ADVANCE', { ...PO, committed: { ADVANCE: 100_000_00, BALANCE: 0 } }), 200_000_00);
  assert.equal(releasable(t, 'ADVANCE', { ...PO, poApproved: false }), 0);
  assert.equal(releasable(parseTerms({ mode: 'AGAINST_GRN' }), 'ADVANCE', PO), 0);
});

test('balance: never more than the accepted value, less everything already committed', () => {
  const t = parseTerms({ mode: 'ADVANCE_BALANCE', advanceBps: 3000 });
  const s = { ...PO, acceptedValuePaise: 800_000_00, committed: { ADVANCE: 300_000_00, BALANCE: 0 } };
  assert.equal(releasable(t, 'BALANCE', s), 500_000_00);
  // a heavy shortfall: accepted less than the advance already paid -> nothing more is payable
  assert.equal(releasable(t, 'BALANCE', { ...s, acceptedValuePaise: 200_000_00 }), 0);
  assert.equal(releasable(parseTerms({ mode: 'AGAINST_GRN' }), 'BALANCE', { ...PO, acceptedValuePaise: 5 }), 5);
});

test('maker-checker: the approver did not request it and did not raise the PO; the releaser did not raise the PO', () => {
  assert.throws(() => checkMakerChecker('approve', { actor: 'u1', requestedBy: 'u1', poCreatedBy: 'u9' }), /requested/);
  assert.throws(() => checkMakerChecker('approve', { actor: 'u9', requestedBy: 'u1', poCreatedBy: 'u9' }), /raised/);
  assert.throws(() => checkMakerChecker('release', { actor: 'u9', requestedBy: 'u1', poCreatedBy: 'u9' }), /raised/);
  checkMakerChecker('approve', { actor: 'u2', requestedBy: 'u1', poCreatedBy: 'u9' });
  checkMakerChecker('release', { actor: 'u2', requestedBy: 'u1', poCreatedBy: 'u9' });
});

test('credit terms become a due date from the GRN or invoice date', () => {
  assert.equal(dueDate({ mode: 'CREDIT', days: 30, from: 'GRN' }, { grnDate: '2026-11-05', invoiceDate: '2026-11-01' }), '2026-12-05');
  assert.equal(dueDate({ mode: 'CREDIT', days: 15, from: 'INVOICE' }, { grnDate: '2026-11-05', invoiceDate: '2026-11-01' }), '2026-11-16');
  assert.equal(dueDate({ mode: 'CREDIT', days: 15, from: 'INVOICE' }, { grnDate: '2026-11-05', invoiceDate: null }), null);
  assert.equal(dueDate({ mode: 'AGAINST_GRN' }, { grnDate: '2026-11-05', invoiceDate: null }), null);
});

/* ── QC decision table ────────────────────────────────────────────────────────── */

const CPS: Checkpoint[] = [
  { id: 'c1', name: 'Odour profile', checkType: 'REFERENCE', critical: true },
  { id: 'c2', name: 'Strength', checkType: 'RANGE', min: 9.5, max: 10.5, critical: false },
  { id: 'c3', name: 'Clarity', checkType: 'PASS_FAIL', critical: false },
];
const RW = { maxReworks: 2, envelopeBps: 500, differentInspector: false };
function q(over: Partial<QcInput> = {}): QcInput {
  return {
    checkpoints: CPS,
    results: [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 10 }, { checkpointId: 'c3', pass: true }],
    policy: RW,
    history: { reworks: 0, failedCheckpointsByRound: [], retests: 0, cumulativeAdjustmentMg: 0 },
    batchMg: 100_000_000,
    ...over,
  };
}

test('all pass -> APPROVE', () => { assert.equal(decideQc(q()).decision, 'APPROVE'); });

test('a range is evaluated by the server, not taken from the client', () => {
  const d = decideQc(q({ results: [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 9 }, { checkpointId: 'c3', pass: true }], defectType: 'STRENGTH' }));
  assert.equal(d.decision, 'REWORK');
  assert.deepEqual(d.failed, ['c2']);
});

test('a never-rework defect rejects straight away, even on a minor checkpoint', () => {
  for (const t of NEVER_REWORK) {
    const d = decideQc(q({ results: [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 10 }, { checkpointId: 'c3', pass: false }], defectType: t }));
    assert.equal(d.decision, 'REJECT', t);
  }
  const lot = decideQc(q({ results: [{ checkpointId: 'c1', pass: false }, { checkpointId: 'c2', value: 10 }, { checkpointId: 'c3', pass: true }], defectType: 'FAULTY_RAW_LOT' }));
  assert.equal(lot.lotHold, true);
});

test('a failed critical checkpoint rejects', () => {
  const d = decideQc(q({ results: [{ checkpointId: 'c1', pass: false }, { checkpointId: 'c2', value: 10 }, { checkpointId: 'c3', pass: true }], defectType: 'COLOUR' }));
  assert.equal(d.decision, 'REJECT');
  assert.equal(d.openCapa, true);
});

test('a failure needs a defect type: the rule decides from it', () => {
  assert.throws(() => decideQc(q({ results: [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 9 }, { checkpointId: 'c3', pass: true }] })), /defect type/i);
});

test('instrument doubt -> HOLD for one retest; a second fail after the retest rejects', () => {
  const r = [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 9 }, { checkpointId: 'c3', pass: true }];
  assert.equal(decideQc(q({ results: r, defectType: 'STRENGTH', instrumentDoubt: true })).decision, 'HOLD_RETEST');
  assert.equal(decideQc(q({ results: r, defectType: 'STRENGTH', instrumentDoubt: true, history: { reworks: 0, failedCheckpointsByRound: [['c2']], retests: 1, cumulativeAdjustmentMg: 0 } })).decision, 'REJECT');
});

test('a second failure on the same checkpoint holds the batch and opens a CAPA', () => {
  const r = [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 9 }, { checkpointId: 'c3', pass: true }];
  const d = decideQc(q({ results: r, defectType: 'STRENGTH', history: { reworks: 1, failedCheckpointsByRound: [['c2']], retests: 0, cumulativeAdjustmentMg: 1_000_000 } }));
  assert.equal(d.decision, 'HOLD_CAPA');
  assert.equal(d.openCapa, true);
  // a different checkpoint failing after rework 1 is an ordinary rework
  const r2 = [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 10 }, { checkpointId: 'c3', pass: false }];
  assert.equal(decideQc(q({ results: r2, defectType: 'CLARITY', history: { reworks: 1, failedCheckpointsByRound: [['c2']], retests: 0, cumulativeAdjustmentMg: 0 } })).decision, 'REWORK');
});

test('the third failure goes to perfumer + vault_approver review, never an automatic reject', () => {
  const r = [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 10 }, { checkpointId: 'c3', pass: false }];
  const d = decideQc(q({ results: r, defectType: 'CLARITY', history: { reworks: 2, failedCheckpointsByRound: [['c2'], ['c1']], retests: 0, cumulativeAdjustmentMg: 0 } }));
  assert.equal(d.decision, 'REVIEW');
});

test('the adjustment envelope: a rework that would take cumulative adjustment past 5% of batch weight goes to review', () => {
  const r = [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 9 }, { checkpointId: 'c3', pass: true }];
  const d = decideQc(q({ results: r, defectType: 'STRENGTH', history: { reworks: 0, failedCheckpointsByRound: [], retests: 0, cumulativeAdjustmentMg: 5_000_000 } }));
  assert.equal(d.decision, 'REVIEW');
  assert.match(d.reasons.join(' '), /envelope/i);
});

test('every QC round after a rework is a full re-QC: every checkpoint must have a result', () => {
  assert.throws(() => validateResults(CPS, [{ checkpointId: 'c2', value: 10 }]), /Odour profile/);
  assert.throws(() => validateResults(CPS, [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2' }, { checkpointId: 'c3', pass: true }]), /Strength/);
  assert.throws(() => validateResults(CPS, [{ checkpointId: 'c1', pass: true }, { checkpointId: 'c2', value: 10 }, { checkpointId: 'c3', pass: true }, { checkpointId: 'zz', pass: true }]), /not on this spec/);
});
