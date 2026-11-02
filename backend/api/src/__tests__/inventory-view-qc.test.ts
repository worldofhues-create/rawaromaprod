/** QC-GATE: raw-material availability is a positive allow-list. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryViewService } from '../inventory-view/inventory-view.service.js';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';

before(async () => { await ensureSchema(); });
after(async () => { await closeTestClient(); });

test('inventory view: only ACCEPT or PASS is available; missing, PENDING and the rest read blocked', async () => {
  const sql = testClient();
  // The harness schema has no status master; the view only left-joins it.
  await sql`create table if not exists inventory.inventory_status_master (inventory_status_id uuid primary key, status_code text)`;
  const svc = new InventoryViewService(sql as never);
  for (const [result, available] of [['ACCEPT', 10], ['PASS', 10], [null, 0], ['PENDING', 0], ['HOLD', 0], ['REJECT', 0], ['SOMETHING', 0]] as const) {
    const id = crypto.randomUUID(), rm = crypto.randomUUID(), material = crypto.randomUUID();
    await sql`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, quantity_on_hand, status)
              values (${id}, ${rm}, ${material}, 10, 'ACTIVE')`;
    if (result) {
      await sql`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, status)
                values (${crypto.randomUUID()}, ${rm}, ${result}, 'ACTIVE')`;
    }
    const row = (await svc.availability({ materialId: material })).items[0] as unknown as { available: number; blocked: number };
    assert.equal(row.available, available, String(result));
    assert.equal(row.blocked, 10 - available, String(result));
  }
});
