/**
 * FLOOR-FIX-12 (Alembic doc 17 §5.5) — the mirror of ALEMBIC's CONTRACT-GUARD-1. Every RawProd bridge
 * test checked RawProd against RawProd, so both halves could drift from ALEMBIC together and stay
 * green. ALEMBIC's lists are PINNED here, copied by hand from
 *   worldofhues-create/alembic origin/lane/contract-guard @ 78aa0ab4 (2026-11-10):
 *   packages/domain/src/bridge/envelope.ts      OUTBOUND_EVENT_TYPES, INBOUND_EVENT_TYPES
 *   packages/domain/src/copilot/rawprod-facts.ts RAWPROD_FACT_KINDS
 *   packages/domain/src/fulfil/contract.ts       the requirement `uom` it emits ("mg")
 *   packages/domain/test/contract-guard-rawprod.test.ts  RP_UOMS (what ALEMBIC believes we convert)
 * When ALEMBIC changes one, update this file in the same release, citing the new commit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { INBOUND_FROM_ALEMBIC, OUTBOUND_TO_ALEMBIC } from '../bridge/contract.js';
import { FACT_KINDS } from '../facts/facts.contract.js';
import { convertQty } from '../bridge/quantity.js';

const ALEMBIC_OUTBOUND_EVENT_TYPES = [
  'ProductionRequirementCreated', 'ProductionRequirementChanged', 'ProductionRequirementCancelled', 'ProductionRequirementFulfilled',
];
const ALEMBIC_INBOUND_EVENT_TYPES = [
  'ProductionRequirementAccepted', 'ProductionRequirementRejectedMapping', 'ProductionScheduled', 'ProductionStarted',
  'QcStatusChanged', 'PackagingStarted', 'FgBatchAvailable', 'AtpAllocationGranted', 'DispatchReady', 'Dispatched',
  'ProductionRequirementCancelledAck', 'ProductionRequirementCompleted',
  'qc.batch.released', 'compliance.certificate.calculated', 'fg.batch.received',
  // PROM-2: alembic lane/prom packages/domain/src/bridge/envelope.ts (ALEMBIC accepts first, then RawProd sends).
  'batch.rest.recorded',
  // PROM-3: alembic lane/prom 87390015 packages/domain/src/bridge/envelope.ts.
  'qc.reference.established',
  // PROM-5: alembic lane/prom packages/domain/src/bridge/envelope.ts.
  'product.continuity.current',
  'product.material.changed',
  // PROM-6: alembic lane/prom 5142a7df packages/domain/src/bridge/envelope.ts.
  'factory.rules.state', 'batch.rest.started',
  'procurement.vendor.upserted', 'procurement.po.issued', 'procurement.po.amended', 'procurement.po.cancelled', 'inventory.grn.created',
  'SalesOrderManualContinuityCreated', 'SalesOrderManualContinuityConfirmed', 'SalesOrderManualContinuityItemAdded',
  // IMPORT-RP-COST (LD-156, 2026-11-13): NOT copied from an ALEMBIC commit. The lead gave both sides the
  // same contract text and ALEMBIC's receiver is being built against it on its own lane; when that lane
  // lands, replace this note with its commit. Until ALEMBIC accepts the type a fact waits parked in
  // bridge.outbox and is replayed under the same event id, so RawProd must not go live with this first.
  'material.cost.recorded',
  // FACTORY-DOCS: alembic st4/docs-auto @ 1ac64c85a packages/domain/src/bridge/envelope.ts:46 (handleGcmsFact,
  // apps/api/src/compliance/gcms.ts). Not yet on ALEMBIC's release branch: until it is, a sent fact parks here.
  'qc.gcms.attached',
];
const ALEMBIC_RAWPROD_FACT_KINDS = [
  'production_requirement_status', 'material_availability', 'po_status', 'grn_status', 'qc_status', 'fg_atp', 'dispatch_status',
  'production_blockers', 'po_late', 'factory_status', 'batch_quarantine',
];
const ALEMBIC_EMITTED_UOMS = ['mg'];
const ALEMBIC_BELIEVED_RP_UOMS = ['mg', 'g', 'kg', 't', 'ml', 'l', 'pcs', 'nos', 'ea'];

const sorted = (a: readonly string[]) => [...a].sort();

test('what ALEMBIC sends is exactly what RawProd accepts', () => {
  assert.deepEqual(sorted(INBOUND_FROM_ALEMBIC), sorted(ALEMBIC_OUTBOUND_EVENT_TYPES));
});

test('every event RawProd sends is one ALEMBIC accepts (an unknown type is parked there forever)', () => {
  const unknown = OUTBOUND_TO_ALEMBIC.filter((t) => !ALEMBIC_INBOUND_EVENT_TYPES.includes(t));
  assert.deepEqual(unknown, []);
});

test('the fact kinds ALEMBIC asks for are exactly the ones RawProd answers', () => {
  assert.deepEqual(sorted(FACT_KINDS), sorted(ALEMBIC_RAWPROD_FACT_KINDS));
});

test('every unit ALEMBIC emits converts here, and ALEMBIC\'s copy of our unit list is still true', () => {
  for (const u of ALEMBIC_EMITTED_UOMS) assert.notEqual(convertQty(1, u, 'kg'), null, `${u} does not convert to kg`);
  for (const u of ALEMBIC_BELIEVED_RP_UOMS) assert.equal(convertQty(1, u, u), 1);
  const dims: Record<string, string> = { mg: 'kg', g: 'kg', kg: 'mg', t: 'kg', ml: 'l', l: 'ml', pcs: 'ea', nos: 'ea', ea: 'pcs' };
  for (const u of ALEMBIC_BELIEVED_RP_UOMS) assert.notEqual(convertQty(1, u, dims[u]!), null, `${u} is in ALEMBIC's list but does not convert here`);
  assert.equal(convertQty(1, 'unit', 'kg'), null, 'RAC\'s `unit` is not convertible: see the unit-refusal test');
});
