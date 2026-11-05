/**
 * PROD-B-2 — the 12.1 shortfall/extra rule and the material audit checklist, as a pure function
 * (backend/api/src/prodfloor/receiving-rule.ts). Quantities are integer base units (mg).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideReceiving,
  toBaseUnits,
  debitNoteLines,
  type AuditLineInput,
  type ShortfallPolicy,
} from '../prodfloor/receiving-rule.js';

const OK = { countWeight: { ok: true }, sealIntact: { ok: true }, labelMatches: { ok: true }, coaPresent: { ok: true }, expiryOk: { ok: true }, noDamage: { ok: true } };
const PO: ShortfallPolicy = { scope: 'PO', shortRejectBps: 2000, extraHoldBps: 500 };
const LINE: ShortfallPolicy = { scope: 'LINE', shortRejectBps: 2000, extraHoldBps: 500 };
const KG = 1_000_000;

function line(id: string, ordered: number, received: number, extra: Partial<AuditLineInput> = {}): AuditLineInput {
  return { poItemId: id, unit: 'mg', orderedBase: ordered, priorReceivedBase: 0, receivedBase: received, damagedBase: 0, checks: OK, ...extra };
}

test('a full delivery is accepted line by line', () => {
  const r = decideReceiving([line('a', 10 * KG, 10 * KG)], PO, { finalDelivery: true });
  assert.equal(r.lines[0]!.decision, 'ACCEPT');
  assert.equal(r.lines[0]!.acceptedBase, 10 * KG);
});

test('PO-wide: one line 50% short but the PO only 10% short -> accepted with the deficit recorded', () => {
  const r = decideReceiving([line('a', 10 * KG, 5 * KG), line('b', 40 * KG, 40 * KG)], PO, { finalDelivery: true });
  assert.equal(r.poShortBps.mg, 1000);
  assert.equal(r.lines[0]!.decision, 'ACCEPT_SHORT');
  assert.equal(r.lines[0]!.acceptedBase, 5 * KG);
  assert.equal(r.lines[0]!.shortBase, 5 * KG);
  assert.equal(r.lines[1]!.decision, 'ACCEPT');
});

test('PO-wide: the PO 20% short -> the short line is rejected, the rest accepted', () => {
  const r = decideReceiving([line('a', 10 * KG, 0 + 6 * KG), line('b', 10 * KG, 10 * KG)], { ...PO, shortRejectBps: 2000 }, { finalDelivery: true });
  // total ordered 20, effective 16 -> 20% short exactly: >= threshold rejects
  assert.equal(r.poShortBps.mg, 2000);
  assert.equal(r.lines[0]!.decision, 'REJECT_LINE');
  assert.equal(r.lines[0]!.acceptedBase, 0);
  assert.equal(r.lines[0]!.rejectedBase, 6 * KG);
  assert.equal(r.lines[1]!.decision, 'ACCEPT');
});

test('per-line option: the same delivery measured per line rejects the 50%-short line', () => {
  const r = decideReceiving([line('a', 10 * KG, 5 * KG), line('b', 40 * KG, 40 * KG)], LINE, { finalDelivery: true });
  assert.equal(r.lines[0]!.decision, 'REJECT_LINE');
  assert.equal(r.lines[1]!.decision, 'ACCEPT');
});

test('damaged quantity counts as short and is never accepted', () => {
  const r = decideReceiving([line('a', 10 * KG, 10 * KG, { damagedBase: 3 * KG })], LINE, { finalDelivery: true });
  assert.equal(r.lines[0]!.decision, 'REJECT_LINE'); // 30% effective short
  const r2 = decideReceiving([line('a', 10 * KG, 10 * KG, { damagedBase: 1 * KG })], LINE, { finalDelivery: true });
  assert.equal(r2.lines[0]!.decision, 'ACCEPT_SHORT');
  assert.equal(r2.lines[0]!.acceptedBase, 9 * KG);
  assert.equal(r2.lines[0]!.rejectedBase, 1 * KG);
});

test('extra within 5% is accepted; above it the excess is held for purchase approval', () => {
  const ok = decideReceiving([line('a', 100 * KG, 105 * KG)], PO, { finalDelivery: true });
  assert.equal(ok.lines[0]!.decision, 'ACCEPT');
  assert.equal(ok.lines[0]!.acceptedBase, 105 * KG);
  const held = decideReceiving([line('a', 100 * KG, 108 * KG)], PO, { finalDelivery: true });
  assert.equal(held.lines[0]!.decision, 'EXCESS_HELD');
  assert.equal(held.lines[0]!.acceptedBase, 100 * KG);
  assert.equal(held.lines[0]!.excessHeldBase, 8 * KG);
});

test('cumulative deliveries: a part delivery is not rejected for shortness before PO close', () => {
  const first = decideReceiving([line('a', 10 * KG, 4 * KG)], PO, { finalDelivery: false });
  assert.equal(first.lines[0]!.decision, 'PENDING_BALANCE');
  assert.equal(first.lines[0]!.acceptedBase, 4 * KG);
  // second delivery closes the PO: cumulative 4 + 5 = 9 of 10 -> 10% short, accepted
  const second = decideReceiving([line('a', 10 * KG, 5 * KG, { priorReceivedBase: 4 * KG })], PO, { finalDelivery: true });
  assert.equal(second.lines[0]!.decision, 'ACCEPT_SHORT');
  assert.equal(second.lines[0]!.shortBase, 1 * KG);
  // or cumulative 4 + 3 = 7 of 10 -> 30% short at close: this delivery's part of the line is rejected
  const bad = decideReceiving([line('a', 10 * KG, 3 * KG, { priorReceivedBase: 4 * KG })], PO, { finalDelivery: true });
  assert.equal(bad.lines[0]!.decision, 'REJECT_LINE');
  assert.equal(bad.lines[0]!.rejectedBase, 3 * KG);
});

test('extra is judged on the cumulative total, even before PO close', () => {
  const r = decideReceiving([line('a', 10 * KG, 7 * KG, { priorReceivedBase: 4 * KG })], PO, { finalDelivery: false });
  assert.equal(r.lines[0]!.decision, 'EXCESS_HELD');
  assert.equal(r.lines[0]!.excessHeldBase, 1 * KG);
  assert.equal(r.lines[0]!.acceptedBase, 6 * KG);
});

test('a label that does not match, or an expired lot, rejects the line whatever the quantity', () => {
  const r = decideReceiving([line('a', 10 * KG, 10 * KG, { checks: { ...OK, labelMatches: { ok: false, reason: 'Label says X' } } })], PO, { finalDelivery: true });
  assert.equal(r.lines[0]!.decision, 'REJECT_LINE');
  assert.match(r.lines[0]!.explain, /label/i);
  const e = decideReceiving([line('a', 10 * KG, 10 * KG, { checks: { ...OK, expiryOk: { ok: false, reason: 'Expired 2026-10' } } })], PO, { finalDelivery: true });
  assert.equal(e.lines[0]!.decision, 'REJECT_LINE');
});

test('every checklist item is ticked or carries a reason', () => {
  assert.throws(() => decideReceiving([line('a', 1, 1, { checks: { ...OK, sealIntact: { ok: false } } })], PO, { finalDelivery: true }), /reason/i);
  const { noDamage: _n, ...missing } = OK;
  assert.throws(() => decideReceiving([line('a', 1, 1, { checks: missing as typeof OK })], PO, { finalDelivery: true }), /noDamage/);
});

test('a partial accept override must split the received quantity exactly and carry a reason', () => {
  const r = decideReceiving([line('a', 10 * KG, 10 * KG, { override: { acceptedBase: 6 * KG, rejectedBase: 4 * KG, reason: 'Two drums cloudy' } })], PO, { finalDelivery: true });
  assert.equal(r.lines[0]!.overridden, true);
  assert.equal(r.lines[0]!.acceptedBase, 6 * KG);
  assert.equal(r.lines[0]!.rejectedBase, 4 * KG);
  assert.throws(() => decideReceiving([line('a', 10, 10, { override: { acceptedBase: 6, rejectedBase: 3, reason: 'x' } })], PO, { finalDelivery: true }), /add up/);
  assert.throws(() => decideReceiving([line('a', 10, 10, { override: { acceptedBase: 6, rejectedBase: 4, reason: ' ' } })], PO, { finalDelivery: true }), /reason/);
});

test('units: kg, g and mg become integer mg; counted units stay units; anything else is refused', () => {
  assert.deepEqual(toBaseUnits('2.5', 'KG'), { unit: 'mg', base: 2_500_000, factor: 1_000_000 });
  assert.deepEqual(toBaseUnits(818.55, 'g'), { unit: 'mg', base: 818_550, factor: 1_000 });
  assert.deepEqual(toBaseUnits(12, 'NOS'), { unit: 'unit', base: 12, factor: 1 });
  assert.equal(toBaseUnits(1, 'L'), null);
  assert.equal(toBaseUnits(1, null), null);
});

test('PO-wide totals are per material unit: kg lines and counted lines never sum together', () => {
  const r = decideReceiving([line('a', 10 * KG, 10 * KG), { ...line('b', 100, 50), unit: 'unit' }], PO, { finalDelivery: true });
  assert.equal(r.poShortBps.mg, 0);
  assert.equal(r.poShortBps.unit, 5000);
  assert.equal(r.lines[1]!.decision, 'REJECT_LINE');
  assert.equal(r.lines[0]!.decision, 'ACCEPT');
});

test('debit note: rejected quantity, and the unreceived shortfall at close, valued once in paise', () => {
  const r = decideReceiving([line('a', 10 * KG, 6 * KG), line('b', 10 * KG, 10 * KG)], PO, { finalDelivery: true });
  // rate is per PO unit (kg here): Rs 1234.56/kg = 123456 paise per 1,000,000 mg
  const lines = debitNoteLines(r.lines, { a: { ratePaise: 123456, factor: KG }, b: { ratePaise: 1, factor: KG } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.poItemId, 'a');
  // rejected 6 kg + short 4 kg = 10 kg x 1234.56
  assert.equal(lines[0]!.amountPaise, 1234560);
});
