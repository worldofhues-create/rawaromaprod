/**
 * STAGE-2-RP: two more answers that name a material were being kept by an idempotency store.
 *
 * The console sends an Idempotency-Key with every write, and the store keeps the write's answer so a
 * re-send is answered from the first attempt. For two routes that answer is not ids and counts:
 *
 *   POST /v1/floor/lots/:id/barcode   (main) the lot's label, which for a role that may read names
 *                                     carries `materialName`. Kept in platform.idempotency_key.
 *   POST /v1/compliance/import        (Vault) every row of an allergen or IFRA sheet: the material's code
 *                                     and name with its composition ("1111-11-1: natural 0.5 %"). Kept in
 *                                     formula.idempotency_key, in plain text, preview and commit alike.
 *
 * Neither needs its answer stored to be correct: the first is a get-or-create (a lot has one barcode, and
 * asking again returns it), the second a preview (reads only) or a REPLACE of each material's rows by
 * the same file. Both are now @NoStoredReply, as the mixer's reveal and the recipe import are: the
 * in-flight claim still stops two copies running at once, and a re-send runs again.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { META_NO_STORED_REPLY } from '@core/backend-kernel';
import { FloorController } from '../floor/floor.controller.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { ComplianceController } from '../../../cluster-formula/src/compliance/compliance.controller.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';

before(ensureSchema);
after(closeTestClient);

test('the lot-label route and the Vault compliance upload never store their answer', () => {
  assert.equal(Reflect.getMetadata(META_NO_STORED_REPLY, FloorController.prototype.mintLot), true, 'POST /v1/floor/lots/:id/barcode');
  assert.equal(Reflect.getMetadata(META_NO_STORED_REPLY, ComplianceController.prototype.import), true, 'POST /v1/compliance/import');
});

test('the lot-label route is safe to run again: a lot has one barcode, and asking twice returns it', async () => {
  const sql = testClient();
  const codes = new FloorCodeService(sql);
  const id = crypto.randomUUID();
  await sql`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, quantity_on_hand, status)
            values (${id}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 5, 'ACTIVE')`;
  const p = principal({ roles: ['warehouse'], userId: crypto.randomUUID() });
  const first = await codes.lotBarcode(id, p), second = await codes.lotBarcode(id, p);
  assert.equal(second, first);
  assert.equal(Number((await sql`select count(*)::int as n from inventory.lot_barcode where inventory_batch_id = ${id}`)[0]!.n), 1);
});
