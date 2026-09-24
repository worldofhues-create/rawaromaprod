/**
 * RP-EMIT (lane F6) — outbound bridge emissions toward ALEMBIC. Covers the shared
 * `emitBridgeOutbound` helper (@core/backend-kernel, backend/backend-kernel/src/events/
 * bridge-emit.ts) directly, plus wiring at each of the seven hook points lane C left:
 * planning.service.ts (ProductionScheduled), mixing.service.ts (ProductionStarted),
 * production batch.service.ts + quality inspections.service.ts (QcStatusChanged),
 * packaging orders.service.ts (PackagingStarted), packaging batch.service.ts
 * (FgBatchAvailable — removed at creation by lane/j2, see its test), reservation.service.ts (AtpAllocationGranted), and
 * dispatch.service.ts (DispatchReady/Dispatched).
 *
 * Required properties (lane brief): for each event, emitted in-transaction with the right
 * version; nothing emitted without a linked requirement; nothing emitted on rollback;
 * versions strictly increase per requirement; a double transition produces no duplicate
 * emission.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { emitBridgeOutbound } from '../../../backend-kernel/src/events/bridge-emit.js';
import { MixingService } from '../../../cluster-production/src/mixing/mixing.service.js';
import { BatchService as ProductionBatchService, qcStatusForBridge } from '../../../cluster-production/src/batch/batch.service.js';
import { PlanningService } from '../../../cluster-production/src/planning/planning.service.js';
import { OrdersService } from '../../../cluster-packaging/src/orders/orders.service.js';
import { BatchService as PackagingBatchService } from '../../../cluster-packaging/src/batch/batch.service.js';
import { ReservationService } from '../../../cluster-packaging/src/reservation/reservation.service.js';
import { DispatchService } from '../../../cluster-sales/src/dispatch/dispatch.service.js';
import { PackagingLookupService } from '../../../cluster-packaging/src/packaging-lookup.service.js';
import { InspectionsService } from '../../../cluster-quality/src/inspections/inspections.service.js';
import type { FormulaLookup, PickIngredient, ReadContext } from '../../../cluster-formula/src/public-api.js';
import {
  ensureSchema,
  productionDb,
  packagingDb,
  salesDb,
  qualityDb,
  testClient,
  principal,
  closeTestClient,
} from '../../../test-support/db.js';

before(async () => {
  await ensureSchema();
});

after(async () => {
  await closeTestClient();
});

/* ── fixtures ─────────────────────────────────────────────────────────── */

/** A fresh bridge.production_requirement row, not yet linked to any production order —
 *  mirrors an ALEMBIC requirement RawProd has accepted but not yet scheduled against. */
async function freshRequirement(): Promise<{ alembicRequirementId: string; correlationId: string }> {
  const sql = testClient();
  const alembicRequirementId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  await sql`insert into bridge.production_requirement
    (production_requirement_id, alembic_requirement_id, org_id, correlation_id, order_ref,
     mapped_sku, qty, uom, needed_by, lifecycle_status, last_applied_version, last_emitted_version)
    values (${crypto.randomUUID()}, ${alembicRequirementId}, ${crypto.randomUUID()}, ${correlationId},
     'ORD-1', 'SKU-1', 10, 'KG', now(), 'ACCEPTED', 1, 0)`;
  return { alembicRequirementId, correlationId };
}

async function linkRequirement(alembicRequirementId: string, productionOrderId: string): Promise<void> {
  const sql = testClient();
  await sql`update bridge.production_requirement
       set production_order_id = ${productionOrderId}
     where alembic_requirement_id = ${alembicRequirementId}`;
}

async function outboxRowsFor(alembicRequirementId: string) {
  const sql = testClient();
  return sql`select type, payload, aggregate_id from bridge.outbox
              where aggregate_id = ${alembicRequirementId} order by seq`;
}

/**
 * Security review R1 (lane R1B): `bridge.outbox` is ONE physical table every test *file*
 * writes into, and `pnpm test` runs test files concurrently (separate processes sharing the
 * same throwaway database) — so "the global row count didn't change" is not a safe assertion
 * once more than one file can emit to it. It was safe when this file was the only bridge
 * emitter in the suite; it stopped being safe the moment a sibling test file (bridge-link-
 * guard.test.ts, added for security review R1 #3) also legitimately emits ProductionScheduled.
 * These two helpers replace "count didn't change" with a check on the actual PRECONDITION
 * `emitBridgeOutbound` requires before it will ever emit anything (see bridge-emit.ts: it
 * looks up `bridge.production_requirement` by `production_order_id` and returns immediately if
 * nothing is linked) — a check that is true or false by this test's OWN fixture construction,
 * not by what any other file happens to be doing at the same moment.
 */
async function assertProductionOrderHasNoRequirementLink(productionOrderId: string): Promise<void> {
  const sql = testClient();
  const rows = await sql`select 1 from bridge.production_requirement where production_order_id = ${productionOrderId}`;
  assert.equal(rows.length, 0, `production order ${productionOrderId} must have no linked bridge requirement — emitBridgeOutbound's own lookup guarantees nothing was emitted for it`);
}

async function assertOilBatchHasNoProductionOrder(oilBatchId: string): Promise<void> {
  const sql = testClient();
  const rows = await sql`select production_order_id from production.oil_batch_master where oil_batch_id = ${oilBatchId}`;
  assert.equal(rows[0]?.production_order_id ?? null, null, `oil batch ${oilBatchId} must have no linked production order — nothing downstream of it can ever resolve a bridge requirement`);
}

async function freshProductionOrder(): Promise<string> {
  const sql = testClient();
  const orderId = crypto.randomUUID();
  await sql`insert into production.production_order (production_order_id, status) values (${orderId}, 'PLANNING')`;
  return orderId;
}

/* ── emitBridgeOutbound (the shared helper every hook calls) ────────────── */

test('emitBridgeOutbound: nothing emitted when the order has no linked requirement', async () => {
  const orderId = crypto.randomUUID(); // deliberately never linked
  // A globally-unique nonce in the payload, not a global outbox row count (see the comment on
  // assertProductionOrderHasNoRequirementLink above) — this stays a genuine outbox-side check of
  // the call's own effect while being completely immune to whatever any OTHER concurrently
  // running test file's own bridge emissions are doing to the same shared table.
  const nonce = crypto.randomUUID();
  await productionDb().transaction(async (tx) => {
    await emitBridgeOutbound(tx, 'ProductionScheduled', orderId, { nonce });
  });
  const sql = testClient();
  const rows = await sql`select 1 from bridge.outbox where payload->>'nonce' = ${nonce}`;
  assert.equal(rows.length, 0, 'no requirement links to this order — nothing to emit');
});

test('emitBridgeOutbound: nothing emitted when productionOrderId is null or undefined', async () => {
  const nonce = crypto.randomUUID();
  await productionDb().transaction(async (tx) => {
    await emitBridgeOutbound(tx, 'ProductionScheduled', null, { nonce });
    await emitBridgeOutbound(tx, 'ProductionScheduled', undefined, { nonce });
  });
  const sql = testClient();
  const rows = await sql`select 1 from bridge.outbox where payload->>'nonce' = ${nonce}`;
  assert.equal(rows.length, 0);
});

test('emitBridgeOutbound: emits in-transaction with a strictly increasing _bridge_version per requirement', async () => {
  const { alembicRequirementId, correlationId } = await freshRequirement();
  const orderId = await freshProductionOrder();
  await linkRequirement(alembicRequirementId, orderId);

  await productionDb().transaction(async (tx) => {
    await emitBridgeOutbound(tx, 'ProductionScheduled', orderId, { step: 'scheduled' });
  });
  await productionDb().transaction(async (tx) => {
    await emitBridgeOutbound(tx, 'ProductionStarted', orderId, { step: 'started' });
  });

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.type, 'ProductionScheduled');
  assert.equal((rows[0]!.payload as Record<string, unknown>)._bridge_version, 1);
  assert.equal((rows[0]!.payload as Record<string, unknown>).correlation_id, correlationId);
  assert.equal(rows[1]!.type, 'ProductionStarted');
  assert.equal((rows[1]!.payload as Record<string, unknown>)._bridge_version, 2);
});

test('emitBridgeOutbound: a rollback of the caller transaction rolls back the emission and the version bump', async () => {
  const { alembicRequirementId } = await freshRequirement();
  const orderId = await freshProductionOrder();
  await linkRequirement(alembicRequirementId, orderId);

  await assert.rejects(
    productionDb().transaction(async (tx) => {
      await emitBridgeOutbound(tx, 'ProductionScheduled', orderId, { step: 'scheduled' });
      throw new Error('boom — simulated failure after the emission call');
    }),
    /boom/,
  );

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 0, 'rollback must undo the outbox insert too');

  const sql = testClient();
  const req = await sql`select last_emitted_version from bridge.production_requirement
                          where alembic_requirement_id = ${alembicRequirementId}`;
  assert.equal(Number(req[0]!.last_emitted_version), 0, 'rollback must undo the version bump too');
});

/* ── ProductionScheduled: planning.service.ts createOrder ───────────────── */

const stubFormulaLookup: FormulaLookup = {
  async getFloorView() {
    return null;
  },
  async resolveManufacturingInstruction() {
    return null;
  },
  async getPickList(_formulaVersionId: string, _ctx: ReadContext): Promise<PickIngredient[] | null> {
    return [{ materialId: crypto.randomUUID(), percentage: 100, sequenceNo: 1 }];
  },
};

test('planning.createOrder: links the requirement and emits ProductionScheduled when alembicRequirementId is given', async () => {
  const svc = new PlanningService(productionDb(), stubFormulaLookup);
  const { alembicRequirementId } = await freshRequirement();

  const { order } = await svc.createOrder(
    { formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId },
    principal(),
  );

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'ProductionScheduled');
  assert.equal((rows[0]!.payload as Record<string, unknown>)._bridge_version, 1);

  const sql = testClient();
  const req = await sql`select production_order_id from bridge.production_requirement
                          where alembic_requirement_id = ${alembicRequirementId}`;
  assert.equal(req[0]!.production_order_id, order.productionOrderId, 'the order must be linked to the requirement');
});

test('planning.createOrder: no alembicRequirementId — RawProd-internal order, nothing emitted', async () => {
  const svc = new PlanningService(productionDb(), stubFormulaLookup);
  const { order } = await svc.createOrder({ formulaVersionId: crypto.randomUUID(), orderQty: 10 }, principal());
  await assertProductionOrderHasNoRequirementLink(order.productionOrderId);
});

test('planning.createOrder: a retry with the same alembicRequirementId never re-links a different order or double-emits', async () => {
  // Security review R1 #3 updated this contract: a retry against an already-linked requirement
  // used to silently no-op the link (0 rows updated, nobody told) and just proceed to create a
  // second, unlinked production order with no emission — a silent inconsistency. It now throws
  // ConflictException instead, loudly refusing the retry rather than quietly doing something
  // different from what the caller asked for. Either way, the important invariant is unchanged:
  // the requirement must stay linked to the FIRST order only, and never emit a second
  // ProductionScheduled for a requirement that's already linked elsewhere.
  const svc = new PlanningService(productionDb(), stubFormulaLookup);
  const { alembicRequirementId } = await freshRequirement();

  const first = await svc.createOrder(
    { formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId },
    principal(),
  );
  // A second order accidentally sent with the same requirement id (e.g. a client retry) must
  // be refused outright, not silently create a second, unlinked order.
  await assert.rejects(
    () =>
      svc.createOrder(
        { formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId },
        principal(),
      ),
    ConflictException,
  );

  const sql = testClient();
  const req = await sql`select production_order_id from bridge.production_requirement
                          where alembic_requirement_id = ${alembicRequirementId}`;
  assert.equal(req[0]!.production_order_id, first.order.productionOrderId, 'the link must stay with the first order');

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 1, 'the already-linked requirement must not emit a second ProductionScheduled');
});

/* ── ProductionStarted: mixing.service.ts startSession ───────────────────── */

test('mixing.startSession: emits ProductionStarted when the session order fulfills a requirement', async () => {
  const svc = new MixingService(productionDb());
  const { alembicRequirementId } = await freshRequirement();
  const orderId = await freshProductionOrder();
  await linkRequirement(alembicRequirementId, orderId);

  await svc.startSession({ productionOrderId: orderId }, principal());

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'ProductionStarted');
});

test('mixing.startSession: nothing emitted for a RawProd-internal order', async () => {
  const svc = new MixingService(productionDb());
  const orderId = await freshProductionOrder();
  await svc.startSession({ productionOrderId: orderId }, principal());
  await assertProductionOrderHasNoRequirementLink(orderId);
});

/* ── QcStatusChanged: production batch.service.ts + quality inspections.service.ts ── */

test('production BatchService.recordProductionQc: emits QcStatusChanged for a linked oil batch', async () => {
  const svc = new ProductionBatchService(productionDb());
  const { alembicRequirementId } = await freshRequirement();
  const orderId = await freshProductionOrder();
  await linkRequirement(alembicRequirementId, orderId);

  const sql = testClient();
  const oilBatchId = crypto.randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, production_order_id, status)
    values (${oilBatchId}, ${orderId}, 'ACTIVE')`;

  await svc.recordProductionQc({ oilBatchId, result: 'PASS' }, principal());

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'QcStatusChanged');
  // lane/j2: the contract field ALEMBIC actually reads (docs/bridge/EVENT_CONTRACT.md).
  assert.equal((rows[0]!.payload as { qc_status?: string }).qc_status, 'passed');
});

test('qcStatusForBridge: maps grades onto the bridge contract vocabulary', () => {
  assert.equal(qcStatusForBridge('PASS'), 'passed');
  assert.equal(qcStatusForBridge('FAIL'), 'failed');
  assert.equal(qcStatusForBridge('REJECT'), 'failed');
  assert.equal(qcStatusForBridge('HOLD'), 'pending');
  assert.equal(qcStatusForBridge(null), 'pending');
});

test('production BatchService.recordProductionQc: nothing emitted for an oil batch with no linked order', async () => {
  const svc = new ProductionBatchService(productionDb());
  const sql = testClient();
  const oilBatchId = crypto.randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, status) values (${oilBatchId}, 'ACTIVE')`;

  await svc.recordProductionQc({ oilBatchId, result: 'PASS' }, principal());
  await assertOilBatchHasNoProductionOrder(oilBatchId);
});

test('quality InspectionsService.dispose: QcStatusChanged never fires for RM QC (no production-order link exists today)', async () => {
  // inspections.service.ts calls emitBridgeOutbound(tx, 'QcStatusChanged', null, ...) — a
  // literal `null`, unconditionally, for every RM QC dispose (RM batches have no path to a
  // production order at all in this schema) — so this is a static, code-level guarantee, not a
  // per-row lookup outcome. No db-side check applies (there is nothing to look up); the call
  // simply must not throw.
  const svc = new InspectionsService(qualityDb());
  const insp = await svc.createInspection({ rmBatchId: crypto.randomUUID() }, principal());
  await svc.dispose(insp.qcInspectionId, { dispositionCode: 'ACCEPT' }, principal());
});

/* ── PackagingStarted: packaging orders.service.ts createPackageOrder ────── */

async function releasedOilBatchFor(orderId: string | null): Promise<string> {
  const sql = testClient();
  const oilBatchId = crypto.randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, production_order_id, status)
    values (${oilBatchId}, ${orderId}, 'RELEASED')`;
  return oilBatchId;
}

test('packaging OrdersService.createPackageOrder: emits PackagingStarted when the oil batch is bridge-linked', async () => {
  const svc = new OrdersService(packagingDb());
  const { alembicRequirementId } = await freshRequirement();
  const orderId = await freshProductionOrder();
  await linkRequirement(alembicRequirementId, orderId);
  const oilBatchId = await releasedOilBatchFor(orderId);

  await svc.createPackageOrder({ productSkuId: crypto.randomUUID(), oilBatchId, orderQty: 10 }, principal());

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'PackagingStarted');
});

test('packaging OrdersService.createPackageOrder: nothing emitted for RawProd-internal oil', async () => {
  const svc = new OrdersService(packagingDb());
  const oilBatchId = await releasedOilBatchFor(null);
  await svc.createPackageOrder({ productSkuId: crypto.randomUUID(), oilBatchId, orderQty: 10 }, principal());
  await assertOilBatchHasNoProductionOrder(oilBatchId);
});

/* ── FgBatchAvailable: packaging batch.service.ts produceFinishedGoodBatch ── */

async function packageOrderFor(oilBatchId: string): Promise<string> {
  const sql = testClient();
  const packageOrderId = crypto.randomUUID();
  await sql`insert into packaging.package_order (package_order_id, oil_batch_id, status)
    values (${packageOrderId}, ${oilBatchId}, 'DRAFT')`;
  return packageOrderId;
}

test('packaging BatchService.produceFinishedGoodBatch: does NOT emit FgBatchAvailable before packaging QC (lane/j2)', async () => {
  const svc = new PackagingBatchService(packagingDb());
  const { alembicRequirementId } = await freshRequirement();
  const orderId = await freshProductionOrder();
  await linkRequirement(alembicRequirementId, orderId);
  const oilBatchId = await releasedOilBatchFor(orderId);
  const packageOrderId = await packageOrderFor(oilBatchId);

  await svc.produceFinishedGoodBatch(
    { packageOrderId, productSkuId: crypto.randomUUID(), batchNumber: 'FG-1', producedQty: 10 },
    principal(),
  );

  // Availability is emitted by PackagingReleaseService on packaging QC PASS
  // (automation/__tests__/packaging-release.test.ts), never at batch creation.
  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.filter((r) => r.type === 'FgBatchAvailable').length, 0);
});

test('packaging BatchService.produceFinishedGoodBatch: nothing emitted for a RawProd-internal package order', async () => {
  const svc = new PackagingBatchService(packagingDb());
  const oilBatchId = await releasedOilBatchFor(null);
  const packageOrderId = await packageOrderFor(oilBatchId);

  await svc.produceFinishedGoodBatch(
    { packageOrderId, productSkuId: crypto.randomUUID(), batchNumber: 'FG-2', producedQty: 10 },
    principal(),
  );
  await assertOilBatchHasNoProductionOrder(oilBatchId);
});

/* ── AtpAllocationGranted: reservation.service.ts createReservation ─────── */

test('reservation.createReservation: emits AtpAllocationGranted three hops back through the bridge link', async () => {
  const svc = new ReservationService(packagingDb());
  const { alembicRequirementId } = await freshRequirement();
  const orderId = await freshProductionOrder();
  await linkRequirement(alembicRequirementId, orderId);
  const oilBatchId = await releasedOilBatchFor(orderId);
  const packageOrderId = await packageOrderFor(oilBatchId);

  const sql = testClient();
  const fgBatchId = crypto.randomUUID();
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, package_order_id, batch_number, produced_qty, status)
    values (${fgBatchId}, ${packageOrderId}, 'FG-R1', 100, 'ACTIVE')`;

  await svc.createReservation({ finishedGoodBatchId: fgBatchId, reservedQty: 10 }, principal());

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'AtpAllocationGranted');
});

test('reservation.createReservation: nothing emitted for a RawProd-internal FG batch', async () => {
  const svc = new ReservationService(packagingDb());
  const oilBatchId = await releasedOilBatchFor(null);
  const packageOrderId = await packageOrderFor(oilBatchId);
  const sql = testClient();
  const fgBatchId = crypto.randomUUID();
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, package_order_id, batch_number, produced_qty, status)
    values (${fgBatchId}, ${packageOrderId}, 'FG-R2', 100, 'ACTIVE')`;

  await svc.createReservation({ finishedGoodBatchId: fgBatchId, reservedQty: 10 }, principal());
  await assertOilBatchHasNoProductionOrder(oilBatchId);
});

/* ── DispatchReady / Dispatched: dispatch.service.ts createDispatch ─────── */

test('dispatch.createDispatch: emits DispatchReady then Dispatched, in order, for a bridge-linked FG batch', async () => {
  const lookup = new PackagingLookupService(packagingDb());
  const svc = new DispatchService(salesDb(), lookup);

  const { alembicRequirementId } = await freshRequirement();
  const orderId = await freshProductionOrder();
  await linkRequirement(alembicRequirementId, orderId);
  const oilBatchId = await releasedOilBatchFor(orderId);
  const packageOrderId = await packageOrderFor(oilBatchId);

  const sql = testClient();
  const fgBatchId = crypto.randomUUID();
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, package_order_id, batch_number, produced_qty, status)
    values (${fgBatchId}, ${packageOrderId}, 'FG-D1', 100, 'ACTIVE')`;

  await svc.createDispatch(
    { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: fgBatchId, dispatchedQty: 10 }] },
    principal(),
  );

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.type, 'DispatchReady');
  assert.equal((rows[0]!.payload as Record<string, unknown>)._bridge_version, 1);
  assert.equal(rows[1]!.type, 'Dispatched');
  assert.equal((rows[1]!.payload as Record<string, unknown>)._bridge_version, 2);
});

test('dispatch.createDispatch: nothing emitted for a RawProd-internal FG batch', async () => {
  const lookup = new PackagingLookupService(packagingDb());
  const svc = new DispatchService(salesDb(), lookup);

  const oilBatchId = await releasedOilBatchFor(null);
  const packageOrderId = await packageOrderFor(oilBatchId);
  const sql = testClient();
  const fgBatchId = crypto.randomUUID();
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, package_order_id, batch_number, produced_qty, status)
    values (${fgBatchId}, ${packageOrderId}, 'FG-D2', 100, 'ACTIVE')`;

  await svc.createDispatch(
    { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: fgBatchId, dispatchedQty: 10 }] },
    principal(),
  );
  await assertOilBatchHasNoProductionOrder(oilBatchId);
});
