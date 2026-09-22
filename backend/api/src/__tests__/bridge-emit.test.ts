/**
 * RP-EMIT (lane F6) — outbound bridge emissions toward ALEMBIC. Covers the shared
 * `emitBridgeOutbound` helper (@core/backend-kernel, backend/backend-kernel/src/events/
 * bridge-emit.ts) directly, plus wiring at each of the seven hook points lane C left:
 * planning.service.ts (ProductionScheduled), mixing.service.ts (ProductionStarted),
 * production batch.service.ts + quality inspections.service.ts (QcStatusChanged),
 * packaging orders.service.ts (PackagingStarted), packaging batch.service.ts
 * (FgBatchAvailable), reservation.service.ts (AtpAllocationGranted), and
 * dispatch.service.ts (DispatchReady/Dispatched).
 *
 * Required properties (lane brief): for each event, emitted in-transaction with the right
 * version; nothing emitted without a linked requirement; nothing emitted on rollback;
 * versions strictly increase per requirement; a double transition produces no duplicate
 * emission.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { emitBridgeOutbound } from '../../../backend-kernel/src/events/bridge-emit.js';
import { MixingService } from '../../../cluster-production/src/mixing/mixing.service.js';
import { BatchService as ProductionBatchService } from '../../../cluster-production/src/batch/batch.service.js';
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

async function outboxCount(): Promise<number> {
  const sql = testClient();
  const rows = await sql`select count(*)::int as c from bridge.outbox`;
  return Number(rows[0]!.c);
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
  const before_ = await outboxCount();
  await productionDb().transaction(async (tx) => {
    await emitBridgeOutbound(tx, 'ProductionScheduled', orderId, { foo: 'bar' });
  });
  assert.equal(await outboxCount(), before_, 'no requirement links to this order — nothing to emit');
});

test('emitBridgeOutbound: nothing emitted when productionOrderId is null or undefined', async () => {
  const before_ = await outboxCount();
  await productionDb().transaction(async (tx) => {
    await emitBridgeOutbound(tx, 'ProductionScheduled', null);
    await emitBridgeOutbound(tx, 'ProductionScheduled', undefined);
  });
  assert.equal(await outboxCount(), before_);
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
  const before_ = await outboxCount();
  await svc.createOrder({ formulaVersionId: crypto.randomUUID(), orderQty: 10 }, principal());
  assert.equal(await outboxCount(), before_);
});

test('planning.createOrder: a retry with the same alembicRequirementId never re-links a different order or double-emits', async () => {
  const svc = new PlanningService(productionDb(), stubFormulaLookup);
  const { alembicRequirementId } = await freshRequirement();

  const first = await svc.createOrder(
    { formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId },
    principal(),
  );
  // A second order accidentally sent with the same requirement id (e.g. a client retry) must
  // not steal the link from the first order, and must not emit a second ProductionScheduled
  // for a requirement that's already linked elsewhere.
  await svc.createOrder(
    { formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId },
    principal(),
  );

  const sql = testClient();
  const req = await sql`select production_order_id from bridge.production_requirement
                          where alembic_requirement_id = ${alembicRequirementId}`;
  assert.equal(req[0]!.production_order_id, first.order.productionOrderId);

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
  const before_ = await outboxCount();
  await svc.startSession({ productionOrderId: orderId }, principal());
  assert.equal(await outboxCount(), before_);
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
});

test('production BatchService.recordProductionQc: nothing emitted for an oil batch with no linked order', async () => {
  const svc = new ProductionBatchService(productionDb());
  const sql = testClient();
  const oilBatchId = crypto.randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, status) values (${oilBatchId}, 'ACTIVE')`;

  const before_ = await outboxCount();
  await svc.recordProductionQc({ oilBatchId, result: 'PASS' }, principal());
  assert.equal(await outboxCount(), before_);
});

test('quality InspectionsService.dispose: QcStatusChanged never fires for RM QC (no production-order link exists today)', async () => {
  const svc = new InspectionsService(qualityDb());
  const insp = await svc.createInspection({ rmBatchId: crypto.randomUUID() }, principal());

  const before_ = await outboxCount();
  await svc.dispose(insp.qcInspectionId, { dispositionCode: 'ACCEPT' }, principal());
  assert.equal(await outboxCount(), before_, 'rm_batch has no production_order_id to resolve — always a no-op');
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
  const before_ = await outboxCount();
  await svc.createPackageOrder({ productSkuId: crypto.randomUUID(), oilBatchId, orderQty: 10 }, principal());
  assert.equal(await outboxCount(), before_);
});

/* ── FgBatchAvailable: packaging batch.service.ts produceFinishedGoodBatch ── */

async function packageOrderFor(oilBatchId: string): Promise<string> {
  const sql = testClient();
  const packageOrderId = crypto.randomUUID();
  await sql`insert into packaging.package_order (package_order_id, oil_batch_id, status)
    values (${packageOrderId}, ${oilBatchId}, 'DRAFT')`;
  return packageOrderId;
}

test('packaging BatchService.produceFinishedGoodBatch: emits FgBatchAvailable two hops back through the bridge link', async () => {
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

  const rows = await outboxRowsFor(alembicRequirementId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'FgBatchAvailable');
});

test('packaging BatchService.produceFinishedGoodBatch: nothing emitted for a RawProd-internal package order', async () => {
  const svc = new PackagingBatchService(packagingDb());
  const oilBatchId = await releasedOilBatchFor(null);
  const packageOrderId = await packageOrderFor(oilBatchId);

  const before_ = await outboxCount();
  await svc.produceFinishedGoodBatch(
    { packageOrderId, productSkuId: crypto.randomUUID(), batchNumber: 'FG-2', producedQty: 10 },
    principal(),
  );
  assert.equal(await outboxCount(), before_);
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

  const before_ = await outboxCount();
  await svc.createReservation({ finishedGoodBatchId: fgBatchId, reservedQty: 10 }, principal());
  assert.equal(await outboxCount(), before_);
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

  const before_ = await outboxCount();
  await svc.createDispatch(
    { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: fgBatchId, dispatchedQty: 10 }] },
    principal(),
  );
  assert.equal(await outboxCount(), before_);
});
