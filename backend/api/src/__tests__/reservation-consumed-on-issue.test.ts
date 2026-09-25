/**
 * OPS-GREEN Act L (lane ops-factory) — reserve -> pick -> issue. The RM reservation the planner
 * held on a batch for a production order is CONSUMED by that order's material issue, in the same
 * transaction as the on-hand debit (ConsumptionService.applyIssue). A reservation on the same
 * batch for a different document is left alone. Real Postgres.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConsumptionService } from '../consumption/consumption.service.js';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';

let consumption: ConsumptionService;
before(async () => { await ensureSchema(); consumption = new ConsumptionService(testClient() as never); });
after(async () => { await closeTestClient(); });

test('the issue consumes its own order\'s reservation on the issued batch, and only that one', async () => {
  const sql = testClient();
  const orderId = crypto.randomUUID(), otherDoc = crypto.randomUUID();
  const materialId = crypto.randomUUID(), batchId = crypto.randomUUID();
  await sql`insert into production.production_order (production_order_id, order_qty, status) values (${orderId}, 10, 'INPROGRESS')`;
  await sql`insert into inventory.inventory_batch (inventory_batch_id, material_id, quantity_on_hand, status)
            values (${batchId}, ${materialId}, 100, 'ACTIVE')`;
  const mine = crypto.randomUUID(), theirs = crypto.randomUUID();
  await sql`insert into inventory.stock_reservation (stock_reservation_id, inventory_batch_id, reserved_qty, reserved_for_document_id, status)
            values (${mine}, ${batchId}, 15, ${orderId}, 'ACTIVE'), (${theirs}, ${batchId}, 5, ${otherDoc}, 'ACTIVE')`;
  const pickListId = crypto.randomUUID(), issueId = crypto.randomUUID();
  await sql`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values (${pickListId}, ${orderId}, 'ACTIVE')`;
  await sql`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, status)
            values (${crypto.randomUUID()}, ${pickListId}, ${materialId}, 15, 'ACTIVE')`;
  await sql`insert into production.material_issue (material_issue_id, production_order_id, material_pick_list_id, status)
            values (${issueId}, ${orderId}, ${pickListId}, 'ACTIVE')`;
  await sql`insert into production.material_issue_item (material_issue_item_id, material_issue_id, material_id, inventory_batch_id, issued_qty, status)
            values (${crypto.randomUUID()}, ${issueId}, ${materialId}, ${batchId}, true, 'ACTIVE')`;

  await (consumption as unknown as { applyIssue(id: string): Promise<void> }).applyIssue(issueId);

  const onHand = (await sql`select quantity_on_hand from inventory.inventory_batch where inventory_batch_id = ${batchId}`)[0]!;
  assert.equal(Number(onHand.quantity_on_hand), 85);
  const rows = await sql`select stock_reservation_id, status, released_dt from inventory.stock_reservation
                          where inventory_batch_id = ${batchId}`;
  const byId = new Map(rows.map((r) => [r.stock_reservation_id as string, r]));
  assert.equal(byId.get(mine)!.status, 'CONSUMED');
  assert.ok(byId.get(mine)!.released_dt);
  assert.equal(byId.get(theirs)!.status, 'ACTIVE');
  assert.equal(byId.get(theirs)!.released_dt, null);

  // Applied once: a second pass changes nothing.
  await (consumption as unknown as { applyIssue(id: string): Promise<void> }).applyIssue(issueId);
  const again = (await sql`select quantity_on_hand from inventory.inventory_batch where inventory_batch_id = ${batchId}`)[0]!;
  assert.equal(Number(again.quantity_on_hand), 85);
});
