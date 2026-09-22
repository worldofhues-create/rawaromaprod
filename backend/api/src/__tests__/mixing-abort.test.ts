/**
 * RP-FAC2 / RP-PROD-004 — secure mixing session fail/abort path (MixingService.abortSession,
 * backend/cluster-production/src/mixing/mixing.service.ts). Before RP-FAC2 the session had no
 * fail/abort path at all. RP-PROD-004 (HIGH, reviewer R1) then found the reversal itself was
 * unsafe: it credited inventory.inventory_batch.quantity_on_hand by the order's PLANNED
 * required_qty for every issued_qty=true ingredient, on the wrong assumption that
 * PickingService.issueMaterials debits inventory synchronously. It never does — the debit is
 * done asynchronously by ConsumptionService (backend/api/src/consumption/consumption.service.ts,
 * an outbox poller) from material_pick_list_items.picked_qty, and an issue with no pick list was
 * never debited by the poller at all. Aborting credited stock that was never removed — unbounded
 * phantom stock on repeat.
 *
 * Covers: happy end, invalid transitions (abort a COMPLETED session, end an ABORTED session,
 * double-abort), the audit trail (a mixing_step_log ABORT row), and the RP-PROD-004 reversal —
 * no-pick-list abort (no inflation), pick-list abort after the real debit (exact credit, even
 * when picked_qty differs from required_qty), and an abort racing the consumer's own debit.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { MixingService } from '../../../cluster-production/src/mixing/mixing.service.js';
import { ConsumptionService } from '../consumption/consumption.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: MixingService;
let consumption: ConsumptionService;

before(async () => {
  await ensureSchema();
  svc = new MixingService(productionDb());
  // ConsumptionService only needs the raw postgres.js client (PG_CLIENT); Nest's @Inject is
  // metadata-only, so a direct construction against the same test client is a real instance,
  // not a mock — it runs the exact same SQL a production worker would.
  consumption = new ConsumptionService(testClient() as never);
});

after(async () => {
  await closeTestClient();
});

/** applyIssue() is `private` at the TS layer only; there is no JS runtime enforcement, and the
 * race tests need to invoke it directly (outside the drain()/outbox poll loop) against a known
 * issue id. */
function applyIssue(issueId: string): Promise<void> {
  return (consumption as unknown as { applyIssue(id: string): Promise<void> }).applyIssue(issueId);
}

async function freshOrder(materialQty: number, batchOnHand: number) {
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
    values (${inventoryBatchId}, ${materialId}, ${batchOnHand}, 'ACTIVE')`;

  return { orderId, materialId, inventoryBatchId };
}

/** An issue raised WITHOUT a pick list — PickingService.issueMaterials now refuses to create
 * these (RP-PROD-004), so this simulates the only way one can still exist: legacy data written
 * directly, same as this file already does for every other fixture. */
async function issueWithoutPickList(orderId: string, materialId: string, inventoryBatchId: string) {
  const sql = testClient();
  const issueId = crypto.randomUUID();
  await sql`insert into production.material_issue (material_issue_id, production_order_id, material_pick_list_id, status)
    values (${issueId}, ${orderId}, null, 'ACTIVE')`;
  await sql`insert into production.material_issue_item
    (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status)
    values (${crypto.randomUUID()}, ${issueId}, ${materialId}, ${inventoryBatchId}, true, 'ACTIVE')`;
  return issueId;
}

/** An issue raised WITH a pick list whose line's picked_qty may differ from the ingredient's
 * required_qty — exactly the gap the old code ignored by crediting required_qty regardless. */
async function issueWithPickList(
  orderId: string,
  materialId: string,
  inventoryBatchId: string,
  pickedQty: number,
) {
  const sql = testClient();
  const pickListId = crypto.randomUUID();
  await sql`insert into production.material_pick_list (material_pick_list_id, production_order_id, status)
    values (${pickListId}, ${orderId}, 'ACTIVE')`;
  await sql`insert into production.material_pick_list_items
    (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, status)
    values (${crypto.randomUUID()}, ${pickListId}, ${materialId}, ${pickedQty}, 'ACTIVE')`;

  const issueId = crypto.randomUUID();
  await sql`insert into production.material_issue (material_issue_id, production_order_id, material_pick_list_id, status)
    values (${issueId}, ${orderId}, ${pickListId}, 'ACTIVE')`;
  await sql`insert into production.material_issue_item
    (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status)
    values (${crypto.randomUUID()}, ${issueId}, ${materialId}, ${inventoryBatchId}, true, 'ACTIVE')`;
  return { pickListId, issueId };
}

async function batchOnHand(inventoryBatchId: string): Promise<number> {
  const sql = testClient();
  const row = (
    await sql`select quantity_on_hand from inventory.inventory_batch where inventory_batch_id = ${inventoryBatchId}`
  )[0]!;
  return Number(row.quantity_on_hand);
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

/* ── RP-PROD-004: the reversal itself ─────────────────────────────────────────────────────── */

test('mixing session abort: no pick list on the issue -> nothing was ever debited, so abort credits NOTHING (no inflation)', async () => {
  const { orderId, materialId, inventoryBatchId } = await freshOrder(15, 100);
  const issueId = await issueWithoutPickList(orderId, materialId, inventoryBatchId);
  const session = await svc.startSession({ productionOrderId: orderId }, principal());

  assert.equal(await batchOnHand(inventoryBatchId), 100);
  const { reversedIngredients } = await svc.abortSession(session.secureMixingSessionId, { reason: 'no pick list' }, principal());
  assert.equal(reversedIngredients, 1);

  // The old bug: this used to jump straight to 115 (100 + required_qty 15) even though the
  // consumer can never debit an issue with no pick list — pure phantom stock.
  assert.equal(await batchOnHand(inventoryBatchId), 100, 'on-hand must be unchanged — nothing was ever taken');

  const sql = testClient();
  const issue = (await sql`select status from production.material_issue where material_issue_id = ${issueId}`)[0]!;
  assert.equal(issue.status, 'VOID', 'an issue that was never debited is voided, not "reversed"');
  const item = (await sql`select status from production.material_issue_item where material_issue_id = ${issueId}`)[0]!;
  assert.equal(item.status, 'REVERSED');
  const ingredient = (
    await sql`select issued_qty from production.production_order_ingredients where production_order_id = ${orderId}`
  )[0]!;
  assert.equal(ingredient.issued_qty, false);

  // And the claim row must exist now, so a late-arriving consumer poll can never debit it either.
  const applied = (
    await sql`select item_count from inventory.material_issue_applied where material_issue_id = ${issueId}`
  )[0]!;
  assert.equal(Number(applied.item_count), 0);
});

test('mixing session abort: a delayed consumer poll after a VOID abort must never debit the issue', async () => {
  const { orderId, materialId, inventoryBatchId } = await freshOrder(15, 100);
  const issueId = await issueWithoutPickList(orderId, materialId, inventoryBatchId);
  const session = await svc.startSession({ productionOrderId: orderId }, principal());
  await svc.abortSession(session.secureMixingSessionId, { reason: 'no pick list' }, principal());

  // Simulate the consumer's poll finally reaching this issue AFTER the abort voided it.
  await applyIssue(issueId);

  assert.equal(await batchOnHand(inventoryBatchId), 100, 'a voided issue must never be debited, ever');
});

test('mixing session abort: pick-list issue already debited by the consumer -> credits EXACTLY picked_qty, not required_qty', async () => {
  // required_qty (15) deliberately differs from picked_qty (12) — the plan and the actual pick
  // diverge, which is legal (partial pick), and the old code credited the wrong one.
  const { orderId, materialId, inventoryBatchId } = await freshOrder(15, 100);
  const { issueId } = await issueWithPickList(orderId, materialId, inventoryBatchId, 12);

  await applyIssue(issueId); // the real async debit, exactly as ConsumptionService would run it
  assert.equal(await batchOnHand(inventoryBatchId), 88, 'sanity: consumer debited picked_qty (12), not required_qty (15)');

  const session = await svc.startSession({ productionOrderId: orderId }, principal());
  const { reversedIngredients } = await svc.abortSession(session.secureMixingSessionId, { reason: 'contamination detected' }, principal());
  assert.equal(reversedIngredients, 1);

  assert.equal(await batchOnHand(inventoryBatchId), 100, 'credited back exactly the 12 that was actually debited');

  const sql = testClient();
  const issue = (await sql`select status from production.material_issue where material_issue_id = ${issueId}`)[0]!;
  assert.equal(issue.status, 'REVERSED', 'a debited issue that was credited back is REVERSED, not VOID');
  const item = (await sql`select status from production.material_issue_item where material_issue_id = ${issueId}`)[0]!;
  assert.equal(item.status, 'REVERSED');
  const ingredient = (
    await sql`select issued_qty from production.production_order_ingredients where production_order_id = ${orderId}`
  )[0]!;
  assert.equal(ingredient.issued_qty, false);

  // The credit itself is a real ledger row (event_qty = 12), not a required_qty-shaped guess.
  const reversal = (
    await sql`select event_qty from inventory.inventory_event_history
      where reference_document_id = ${issueId} and event_type = 'PRODUCTION_ISSUE_REVERSAL'`
  )[0]!;
  assert.equal(Number(reversal.event_qty), 12);
});

test('mixing session abort: releases any open RM stock_reservation for the order', async () => {
  const { orderId, materialId, inventoryBatchId } = await freshOrder(15, 100);
  const { issueId } = await issueWithPickList(orderId, materialId, inventoryBatchId, 15);
  await applyIssue(issueId);

  const sql = testClient();
  const reservationId = crypto.randomUUID();
  await sql`insert into inventory.stock_reservation
    (stock_reservation_id, inventory_batch_id, reserved_qty, reserved_for_document_id, status)
    values (${reservationId}, ${inventoryBatchId}, 15, ${orderId}, 'ACTIVE')`;

  const session = await svc.startSession({ productionOrderId: orderId }, principal());
  await svc.abortSession(session.secureMixingSessionId, { reason: 'contamination detected' }, principal());

  const reservation = (
    await sql`select status, released_dt from inventory.stock_reservation where stock_reservation_id = ${reservationId}`
  )[0]!;
  assert.equal(reservation.status, 'RELEASED');
  assert.ok(reservation.released_dt, 'reservation must be released, not left dangling');
});

test('mixing session abort: racing the consumer\'s own debit — on-hand always ends up unchanged, and it is never applied twice', async () => {
  const { orderId, materialId, inventoryBatchId } = await freshOrder(15, 100);
  const { issueId } = await issueWithPickList(orderId, materialId, inventoryBatchId, 15);
  const session = await svc.startSession({ productionOrderId: orderId }, principal());

  const results = await Promise.allSettled([
    svc.abortSession(session.secureMixingSessionId, { reason: 'racing the consumer' }, principal()),
    applyIssue(issueId),
  ]);
  assert.equal(results[0]!.status, 'fulfilled', 'abort itself must not fail because of the race');

  // Whichever side won the single-applier claim, the net effect on on-hand must be zero: either
  // the consumer never got to debit (abort won, VOID, no credit needed), or it debited and abort
  // credited it straight back (consumer won, REVERSED). Either way, no phantom stock and no
  // stuck debit.
  assert.equal(await batchOnHand(inventoryBatchId), 100);

  const sql = testClient();
  const applied = await sql`select item_count from inventory.material_issue_applied where material_issue_id = ${issueId}`;
  assert.equal(applied.length, 1, 'the single-applier claim row must exist exactly once — no double-apply');

  const issue = (await sql`select status from production.material_issue where material_issue_id = ${issueId}`)[0]!;
  assert.ok(['VOID', 'REVERSED'].includes(String(issue.status)));
});

test('mixing session abort: two issues on the same order — one voided (no pick list), one credited (debited) — settle independently', async () => {
  const { orderId, materialId: materialA, inventoryBatchId: batchA } = await freshOrder(15, 100);
  const materialB = crypto.randomUUID();
  const sql = testClient();
  const batchB = crypto.randomUUID();
  await sql`insert into production.production_order_ingredients
    (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, status)
    values (${crypto.randomUUID()}, ${orderId}, ${materialB}, 20, true, 'ACTIVE')`;
  await sql`insert into inventory.inventory_batch (inventory_batch_id, material_id, quantity_on_hand, status)
    values (${batchB}, ${materialB}, 50, 'ACTIVE')`;

  const voidIssueId = await issueWithoutPickList(orderId, materialA, batchA);
  const { issueId: creditedIssueId } = await issueWithPickList(orderId, materialB, batchB, 20);
  await applyIssue(creditedIssueId);
  assert.equal(await batchOnHand(batchB), 30);

  const session = await svc.startSession({ productionOrderId: orderId }, principal());
  const { reversedIngredients } = await svc.abortSession(session.secureMixingSessionId, { reason: 'both fail' }, principal());
  assert.equal(reversedIngredients, 2);

  assert.equal(await batchOnHand(batchA), 100, 'never-debited issue: no credit');
  assert.equal(await batchOnHand(batchB), 50, 'debited issue: credited back exactly what was taken');

  const voidIssue = (await sql`select status from production.material_issue where material_issue_id = ${voidIssueId}`)[0]!;
  assert.equal(voidIssue.status, 'VOID');
  const creditedIssue = (await sql`select status from production.material_issue where material_issue_id = ${creditedIssueId}`)[0]!;
  assert.equal(creditedIssue.status, 'REVERSED');
});
