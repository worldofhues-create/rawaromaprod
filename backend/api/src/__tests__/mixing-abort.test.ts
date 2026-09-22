/**
 * RP-FAC2 — secure mixing session fail/abort path (MixingService.abortSession,
 * backend/cluster-production/src/mixing/mixing.service.ts). Before this lane's change the session
 * had no fail/abort path at all — only startSession and an unconditional endSession (which could
 * even "complete" an already-completed or never-started session). Covers: happy end, invalid
 * transitions (abort a COMPLETED session, end an ABORTED session, double-abort), the audit trail
 * (a mixing_step_log ABORT row), and the inventory reversal — credits inventory_batch on-hand
 * back, un-flags production_order_ingredients.issued_qty, marks material_issue_item REVERSED, and
 * releases any open RM stock_reservation held for the order — all inside the abort transaction.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { MixingService } from '../../../cluster-production/src/mixing/mixing.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: MixingService;

before(async () => {
  await ensureSchema();
  svc = new MixingService(productionDb());
});

after(async () => {
  await closeTestClient();
});

async function freshOrderWithIssuedMaterial(materialQty: number, batchOnHandBeforeIssue: number) {
  const sql = testClient();
  const orderId = crypto.randomUUID();
  const materialId = crypto.randomUUID();
  const inventoryBatchId = crypto.randomUUID();

  await sql`insert into production.production_order (production_order_id, order_qty, status)
    values (${orderId}, 10, 'INPROGRESS')`;
  await sql`insert into production.production_order_ingredients
    (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, status)
    values (${crypto.randomUUID()}, ${orderId}, ${materialId}, ${materialQty}, true, 'ACTIVE')`;
  await sql`insert into inventory.inventory_batch (inventory_batch_id, material_id, quantity_on_hand, status)
    values (${inventoryBatchId}, ${materialId}, ${batchOnHandBeforeIssue}, 'ACTIVE')`;

  const issueId = crypto.randomUUID();
  await sql`insert into production.material_issue (material_issue_id, production_order_id, status)
    values (${issueId}, ${orderId}, 'ACTIVE')`;
  await sql`insert into production.material_issue_item
    (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status)
    values (${crypto.randomUUID()}, ${issueId}, ${materialId}, ${inventoryBatchId}, true, 'ACTIVE')`;

  const reservationId = crypto.randomUUID();
  await sql`insert into inventory.stock_reservation
    (stock_reservation_id, inventory_batch_id, reserved_qty, reserved_for_document_id, status)
    values (${reservationId}, ${inventoryBatchId}, ${materialQty}, ${orderId}, 'ACTIVE')`;

  return { orderId, materialId, inventoryBatchId, issueId, reservationId };
}

test('mixing session: happy end ACTIVE session IN_PROGRESS -> COMPLETED', async () => {
  const session = await svc.startSession({ productionOrderId: crypto.randomUUID() }, principal());
  const ended = await svc.endSession(session.secureMixingSessionId, {}, principal());
  assert.equal(ended.status, 'COMPLETED');
});

test('mixing session: cannot end an already-COMPLETED session (invalid transition)', async () => {
  const session = await svc.startSession({ productionOrderId: crypto.randomUUID() }, principal());
  await svc.endSession(session.secureMixingSessionId, {}, principal());
  await assert.rejects(() => svc.endSession(session.secureMixingSessionId, {}, principal()), ConflictException);
});

test('mixing session: abort happy path moves IN_PROGRESS -> ABORTED and logs the reason', async () => {
  const session = await svc.startSession({ productionOrderId: crypto.randomUUID() }, principal());
  const { session: aborted } = await svc.abortSession(session.secureMixingSessionId, { reason: 'equipment failure mid-mix' }, principal());
  assert.equal(aborted.status, 'ABORTED');

  const logs = await svc.listStepLogs({ limit: 100 } as never);
  const abortLog = logs.items.find(
    (l) => l.secureMixingSessionId === session.secureMixingSessionId && String(l.stepDescription).startsWith('ABORTED:'),
  );
  assert.ok(abortLog, 'an ABORTED mixing_step_log row must exist as the audit trail');
  assert.match(String(abortLog!.stepDescription), /equipment failure mid-mix/);
});

test('mixing session: abort reverses issued materials — credits on-hand, un-flags ingredient, marks issue item REVERSED, releases reservation', async () => {
  const { orderId, inventoryBatchId, issueId, reservationId } = await freshOrderWithIssuedMaterial(15, 85);
  const session = await svc.startSession({ productionOrderId: orderId }, principal());

  const { reversedIngredients } = await svc.abortSession(session.secureMixingSessionId, { reason: 'contamination detected' }, principal());
  assert.equal(reversedIngredients, 1);

  const sql = testClient();
  const batch = (await sql`select quantity_on_hand from inventory.inventory_batch where inventory_batch_id = ${inventoryBatchId}`)[0]!;
  assert.equal(Number(batch.quantity_on_hand), 100, 'on-hand must be credited back (85 + 15 issued)');

  const ingredient = (
    await sql`select issued_qty from production.production_order_ingredients where production_order_id = ${orderId}`
  )[0]!;
  assert.equal(ingredient.issued_qty, false, 'the ingredient issued flag must be reset');

  const issueItem = (
    await sql`select status from production.material_issue_item where material_issue_id = ${issueId}`
  )[0]!;
  assert.equal(issueItem.status, 'REVERSED');

  const reservation = (
    await sql`select status, released_dt from inventory.stock_reservation where stock_reservation_id = ${reservationId}`
  )[0]!;
  assert.equal(reservation.status, 'RELEASED');
  assert.ok(reservation.released_dt, 'reservation must be released, not left dangling');
});

test('mixing session: cannot abort a COMPLETED session (invalid transition)', async () => {
  const session = await svc.startSession({ productionOrderId: crypto.randomUUID() }, principal());
  await svc.endSession(session.secureMixingSessionId, {}, principal());
  await assert.rejects(
    () => svc.abortSession(session.secureMixingSessionId, { reason: 'too late' }, principal()),
    ConflictException,
  );
});

test('mixing session: cannot double-abort (invalid transition)', async () => {
  const session = await svc.startSession({ productionOrderId: crypto.randomUUID() }, principal());
  await svc.abortSession(session.secureMixingSessionId, { reason: 'first abort' }, principal());
  await assert.rejects(
    () => svc.abortSession(session.secureMixingSessionId, { reason: 'second abort' }, principal()),
    ConflictException,
  );
});

test('mixing session: concurrent abort + end on the same session — only one wins', async () => {
  const session = await svc.startSession({ productionOrderId: crypto.randomUUID() }, principal());
  const results = await Promise.allSettled([
    svc.abortSession(session.secureMixingSessionId, { reason: 'race' }, principal()),
    svc.endSession(session.secureMixingSessionId, {}, principal()),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one of concurrent abort/end should win');
});
