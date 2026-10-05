/**
 * Always-on Ruh — the detectors and predictions, PURE, with a fixed clock (ruh/ruh-detectors.ts).
 * Facts in, insights out: each deterministic finding names the exact fix, each prediction carries
 * its basis and a confidence, Vault findings are counts only, and nothing depends on "now" but the
 * clock passed in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DETECTOR_KINDS, detectBridge, detectMaterials, detectProduction, detectQc, detectSetup, detectShelf, detectVault,
  type QueueFact,
} from '../ruh/ruh-detectors.js';
import { RUH_DEFAULTS, type RuhSettings } from '../ruh/ruh-settings.service.js';
import { toC3Signal, vaultSafe, alembicRolesFor, absoluteLink } from '../ruh/ruh.contract.js';
import { edgeShare } from '../ruh/ruh-guards.service.js';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const S: RuhSettings = { ...RUH_DEFAULTS };
const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

function req(over: Partial<QueueFact> & { id: string; position: number }): QueueFact {
  return {
    orderRef: `SO-${over.id}`, sku: `SKU-${over.id}`, productCode: null, qtyKg: 10, uom: 'kg', neededBy: day(30),
    priorityRank: over.position, highValue: false, stage: 'TO_PLAN', blockReason: null, ...over,
  };
}

test('every detector kind belongs to exactly one group', () => {
  const all = Object.values(DETECTOR_KINDS).flat();
  assert.equal(new Set(all).size, all.length);
});

test('production: blocked requirements, one insight per reason, with the exact fix; urgent when high value or overdue', () => {
  const out = detectProduction({
    queue: [
      req({ id: 'a', position: 1, stage: 'BLOCKED', blockReason: 'NO_APPROVED_FORMULA' }),
      req({ id: 'b', position: 2, stage: 'BLOCKED', blockReason: 'NO_APPROVED_FORMULA', highValue: true }),
      req({ id: 'c', position: 3, stage: 'UNKNOWN_SKU' }),
      req({ id: 'd', position: 4, stage: 'BLOCKED', blockReason: 'QTY_NOT_IN_KG', qtyKg: null, uom: 'pcs' }),
      req({ id: 'e', position: 5, stage: 'BLOCKED', blockReason: 'NO_FORMULA_LINK' }),
    ],
    throughput: { kg: 0, batches: 0, windowDays: 14 },
  }, NOW).filter((i) => i.kind === 'production.blocked');
  const by = Object.fromEntries(out.map((i) => [i.dedupeKey, i]));
  assert.equal(out.length, 4);
  assert.equal(by['production.blocked:NO_APPROVED_FORMULA']!.severity, 'urgent', 'a high-value order is among them');
  assert.match(by['production.blocked:NO_APPROVED_FORMULA']!.title, /^2 orders waiting for an approved formula$/);
  assert.match(by['production.blocked:NO_APPROVED_FORMULA']!.body, /Fix: A formulator seals the recipe in the Vault and a different approver approves it/);
  assert.match(by['production.blocked:UNKNOWN_SKU']!.body, /Fix: Add the SKU on the Product SKUs screen/);
  assert.equal(by['production.blocked:UNKNOWN_SKU']!.deepLink, '#/go/skus|produce/c');
  assert.match(by['production.blocked:QTY_NOT_IN_KG']!.body, /resend the requirement in kg/);
  assert.equal(by['production.blocked:NO_FORMULA_LINK']!.deepLink, '#/go/formulasetup');
  assert.ok(out.every((i) => i.mirror && i.console === 'factory'));
});

test('production: a higher-ranked order waits while lower-ranked ones are in production', () => {
  const out = detectProduction({
    queue: [
      req({ id: 'hv', position: 1, highValue: true }),
      req({ id: 'x', position: 2, stage: 'IN_PRODUCTION' }),
      req({ id: 'y', position: 3, stage: 'PLANNED' }),
      req({ id: 'z', position: 4 }),
    ],
    throughput: { kg: 0, batches: 0, windowDays: 14 },
  }, NOW).filter((i) => i.kind === 'production.priority_waiting');
  assert.equal(out.length, 1, 'only the order ranked above started work');
  assert.equal(out[0]!.severity, 'urgent');
  assert.equal(out[0]!.subject.id, 'hv');
  assert.match(out[0]!.body, /number 1 in the queue and not planned, while SO-x, SO-y ranked below it/);
  assert.equal(out[0]!.deepLink, '#/go/produce/hv');
});

test('prediction: queue position × recent output → predicted finish vs need-by, with basis and confidence', () => {
  // 20 kg/day (280 kg over 14 days, 12 batches). Ahead of "late": 100 + 100 kg → 10 days; needed in 5.
  const out = detectProduction({
    queue: [
      req({ id: 'first', position: 1, qtyKg: 100, stage: 'IN_PRODUCTION', neededBy: day(20) }),
      req({ id: 'late', position: 2, qtyKg: 100, neededBy: day(5) }),
      req({ id: 'fine', position: 3, qtyKg: 10, neededBy: day(30) }),
      req({ id: 'shelved', position: 4, qtyKg: 999, stage: 'ON_SHELF', neededBy: day(-3) }),
    ],
    throughput: { kg: 280, batches: 12, windowDays: 14 },
  }, NOW).filter((i) => i.kind === 'production.late');
  assert.deepEqual(out.map((i) => i.subject.id), ['late'], 'on-time and already-shelved orders are quiet');
  const p = out[0]!.prediction!;
  assert.equal(p.metric, 'production_finish');
  assert.equal(p.value, day(10));
  assert.equal(p.at, NOW.toISOString());
  assert.equal(p.confidence, 0.8, '12 batches of history');
  assert.match(p.basis, /^200 kg still to make for this order and those ranked ahead of it, at 20 kg a day \(the oil batches made in the last 14 days, 12 batches\)\.$/);
  assert.match(out[0]!.title, /likely to be late: about 2026-10-16, needed by 2026-10-11/);
  assert.equal(out[0]!.severity, 'warn');
});

test('prediction: no output history → no guess; overdue is still reported (deterministic)', () => {
  const out = detectProduction({
    queue: [req({ id: 'o', position: 1, neededBy: day(-2), stage: 'QC_PENDING' }), req({ id: 'n', position: 2, neededBy: day(1) })],
    throughput: { kg: 0, batches: 0, windowDays: 14 },
  }, NOW).filter((i) => i.kind === 'production.late');
  assert.deepEqual(out.map((i) => [i.subject.id, i.severity, i.prediction]), [['o', 'urgent', null]]);
  assert.match(out[0]!.body, /2 day\(s\) late and waiting for QC/);
});

test('QC: COA missing / release waiting past the hour thresholds; NO_SPEC for products in production; Ruh drafts', () => {
  const out = detectQc({
    coaMissing: [{ oilBatchId: 'b1', batchNumber: 'OB-1', ageHours: 30 }, { oilBatchId: 'b2', batchNumber: 'OB-2', ageHours: 2 }],
    releaseWaiting: [{ batchCoaId: 'c1', batchNumber: 'OB-9', ageHours: 40 }],
    noSpec: [{ productId: 'p1', productCode: 'P-1', pendingBatches: 1, openRequirements: 2 }, { productId: 'p2', productCode: 'P-2', pendingBatches: 0, openRequirements: 0 }],
    proposals: { qcSpec: 3, rackLayout: 1 },
  }, S);
  const by = Object.fromEntries(out.map((i) => [i.dedupeKey, i]));
  assert.match(by['qc.coa_missing']!.title, /^1 batch waiting for COA results for more than 24 h$/);
  assert.equal(by['qc.coa_missing']!.severity, 'warn');
  assert.equal(by['qc.release_waiting']!.severity, 'urgent', '40 h ≥ 3 × 12 h');
  assert.equal(by['qc.release_waiting']!.deepLink, '#/go/coa/c1');
  assert.ok(by['qc.no_spec:p1'] && !by['qc.no_spec:p2'], 'only products with work waiting');
  assert.match(by['qc.proposals_waiting']!.title, /Ruh drafted 3 QC specs/);
  assert.equal(by['shelf.rack_proposal_waiting']!.audienceRoles[0], 'warehouse');
});

test('factory setup: the steps left, or nothing when complete', () => {
  assert.deepEqual(detectSetup({ catalogueProducts: 5, packsNeedingDensity: 0, qcSpecsMissing: 0, bins: 10, rackProposed: false, pickLightMode: 'off', formulasUnlinked: 0 }), []);
  const [i] = detectSetup({ catalogueProducts: 0, packsNeedingDensity: 2, qcSpecsMissing: 1, bins: 0, rackProposed: true, pickLightMode: 'unset', formulasUnlinked: 3 });
  assert.match(i!.title, /^Factory setup: 6 steps left$/);
  assert.match(i!.body, /approve the rack layout/);
  assert.equal(i!.mirror, false);
});

test('Vault: counts only; every Vault signal passes vaultSafe and carries no id, code or name', () => {
  const out = detectVault({ counts: { awaitingApproval: 4, recipesNeeded: 2, complianceWarnings: 1 }, formulaBlocked: 3, ruhGrantPending: true });
  assert.deepEqual(out.map((i) => i.kind).sort(), [...DETECTOR_KINDS.vault].sort());
  for (const i of out.filter((x) => x.console === 'vault')) {
    assert.deepEqual(i.subject, { type: 'vault' });
    const sig = toC3Signal(i, { factory: null, platform: null, vault: 'https://rawvault.example.in' });
    assert.ok(vaultSafe(sig));
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(JSON.stringify(sig)));
  }
  assert.equal(out.find((i) => i.kind === 'vault.recipes_awaiting_approval')!.severity, 'warn', 'factory orders are waiting');
  assert.deepEqual(detectVault({ counts: { awaitingApproval: 0, recipesNeeded: 0, complianceWarnings: 0 }, formulaBlocked: 0, ruhGrantPending: false }), []);
});

test('vaultSafe refuses anything that could identify a formula', () => {
  const base = { kind: 'k', severity: 'info' as const, title: 't', body: 'b', dedupeKey: 'd', audienceRoles: ['ops' as const] };
  assert.throws(() => vaultSafe({ ...base, body: 'formula 0190f0a1-0000-7000-8000-00000000c47a' }));
  assert.throws(() => vaultSafe({ ...base, body: 'formula code FRM-0042' }));
  assert.throws(() => vaultSafe({ ...base, body: 'Linalool 12%' }));
  assert.ok(vaultSafe({ ...base, body: '4 recipes waiting for approval' }));
});

test('shelves: overdue tasks by kind, bins near/over the batch limit, quarantine, parked light commands', () => {
  const out = detectShelf({
    overdue: [{ kind: 'PICK', count: 2, oldestHours: 30, oldestTaskId: 't1' }, { kind: 'PUTAWAY', count: 1, oldestHours: 1, oldestTaskId: 't2' }],
    bins: [{ binId: 'b1', label: 'A-1-1', batches: 4, qty: 10 }, { binId: 'b2', label: 'A-1-2', batches: 5, qty: 10 }, { binId: 'b3', label: 'A-1-3', batches: 1, qty: 1 }],
    quarantine: { count: 3, oldestHours: 100 },
    pickLightParked: 2,
  }, S);
  const by = Object.fromEntries(out.map((i) => [i.dedupeKey, i]));
  assert.equal(by['shelf.tasks_overdue:PICK']!.severity, 'urgent', '30 h ≥ 3 × 8 h');
  assert.ok(!by['shelf.tasks_overdue:PUTAWAY']);
  assert.equal(by['shelf.bin_full:b1']!.severity, 'suggest', '4 of 4 = nearly full');
  assert.equal(by['shelf.bin_full:b2']!.severity, 'warn', 'over');
  assert.ok(!by['shelf.bin_full:b3']);
  assert.equal(by['inventory.quarantine']!.severity, 'warn');
  assert.equal(by['shelf.pick_light_parked']!.console, 'platform');
});

test('materials: run-out prediction from on-hand ÷ recent daily issue; short for planned runs is urgent and quantity-free', () => {
  const out = detectMaterials({
    noFloorCode: { count: 2, sample: ['RM-A', 'RM-B'] },
    stock: [
      { materialId: 'm1', code: 'RM-1', name: 'Linalool', available: 30, dailyUse: 10, shortForPlannedRuns: false, uom: 'kg', issueDays: 12 },
      { materialId: 'm2', code: 'RM-2', name: 'Hedione', available: 500, dailyUse: 1, shortForPlannedRuns: false, uom: 'kg', issueDays: 3 },
      { materialId: 'm3', code: 'RM-3', name: 'Iso E', available: 5, dailyUse: 0, shortForPlannedRuns: true, uom: 'kg', issueDays: 0 },
    ],
  }, S, NOW);
  const by = Object.fromEntries(out.map((i) => [i.dedupeKey, i]));
  assert.ok(by['masterdata.no_floor_code']);
  const m1 = by['inventory.low_stock:m1']!;
  assert.match(m1.title, /^RM-1 runs out in about 3 day\(s\)$/);
  assert.equal(m1.prediction!.value, day(3));
  assert.equal(m1.prediction!.confidence, 0.8);
  assert.match(m1.prediction!.basis, /30 kg available ÷ 10 kg a day \(average issue over the last 30 days, 12 days with issues\)/);
  assert.ok(!by['inventory.low_stock:m2'], '500 days of cover');
  const m3 = by['inventory.low_stock:m3']!;
  assert.equal(m3.severity, 'urgent');
  assert.match(m3.title, /not enough on hand for the runs already planned/);
  assert.ok(!/need|required/.test(m3.body), 'the planned quantity (formula-derived) is never reported');
});

test('bridge: not connected; failing (parked or stale); catalogue stale; Ruh queue stuck', () => {
  assert.equal(detectBridge({ connector: { configured: false, enabled: false }, outbound: { waiting: 0, parked: 0, oldestWaitingAt: null }, catalogue: { items: 0, lastSyncedAt: null }, ruhQueue: { waiting: 0, parked: 0, oldestWaitingAt: null } }, S, NOW)[0]!.kind, 'bridge.not_connected');
  const out = detectBridge({
    connector: { configured: true, enabled: true },
    outbound: { waiting: 3, parked: 0, oldestWaitingAt: new Date(NOW.getTime() - 45 * 60_000).toISOString() },
    catalogue: { items: 10, lastSyncedAt: day(-5) },
    ruhQueue: { waiting: 2, parked: 1, oldestWaitingAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() },
  }, S, NOW);
  const by = Object.fromEntries(out.map((i) => [i.kind, i]));
  assert.equal(by['bridge.failing']!.severity, 'warn');
  assert.match(by['bridge.failing']!.body, /the oldest for 45 min/);
  assert.equal(by['bridge.catalogue_stale']!.severity, 'warn', '120 h ≥ 2 × 48 h');
  assert.ok(by['ruh.signals_stuck']);
  assert.ok(out.every((i) => i.console === 'platform' && i.deepLink === '#/bridge'));
});

test('C3 mapping: ALEMBIC roles admin/ops/dispatch; absolute https links only when the console address is set', () => {
  assert.deepEqual(alembicRolesFor(['production', 'qc']), ['ops']);
  assert.deepEqual(alembicRolesFor(['sales', 'owner']), ['admin', 'dispatch']);
  assert.deepEqual(alembicRolesFor(['nobody']), ['admin']);
  assert.equal(absoluteLink('factory', '#/go/produce/x', { factory: 'https://rawfactory.example.in', platform: null, vault: null }), 'https://rawfactory.example.in/#/go/produce/x');
  assert.equal(absoluteLink('platform', '#/bridge', { factory: null, platform: null, vault: null }), null);
});

test('COA edge: share of the spec range to the nearer limit; outside the spec is not an edge (the service refuses it)', () => {
  assert.deepEqual(edgeShare(0.951, 0.94, 0.952), { share: (0.952 - 0.951) / (0.952 - 0.94), limit: 'upper' });
  assert.equal(edgeShare(95, 90, 110)!.limit, 'lower');
  assert.equal(edgeShare(0.96, 0.94, 0.952), null);
  assert.equal(edgeShare(1, 1, 1), null);
});
