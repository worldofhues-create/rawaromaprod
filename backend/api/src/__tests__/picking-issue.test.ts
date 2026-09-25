/**
 * RP-PROD-004 — PickingService.issueMaterials (backend/cluster-production/src/picking/
 * picking.service.ts) now refuses an issue with no materialPickListId. Production cannot debit
 * inventory.inventory_batch itself (cluster boundary) — the async ConsumptionService
 * (backend/api/src/consumption/consumption.service.ts) is what actually decrements on-hand, and
 * it can only do that from a material_pick_list_items.picked_qty line. An issue raised with no
 * pick list has no quantity anywhere for the consumer to apply, so it was silently never debited
 * — and MixingService.abortSession used to still credit it back on abort (see mixing-abort.test.
 * ts), minting phantom stock. Refusing it here closes the gap at the source.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PickingService } from '../../../cluster-production/src/picking/picking.service.js';
import type { VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

// This suite exercises issueMaterials only — never the §109.7 manufacturing-instruction read
// — so a stub that never resolves anything real is enough to satisfy PickingService's
// constructor (it also takes the VAULT_PORT, see picking.service.ts).
const stubFormulaLookup: VaultPort = {
  async resolveManufacturingInstruction() {
    return null;
  },
  async resolvePickList() {
    return null;
  },
};

let svc: PickingService;

before(async () => {
  await ensureSchema();
  svc = new PickingService(productionDb(), stubFormulaLookup);
});

after(async () => {
  await closeTestClient();
});

async function freshOrderWithPickList() {
  const sql = testClient();
  const orderId = crypto.randomUUID();
  const materialId = crypto.randomUUID();
  const inventoryBatchId = crypto.randomUUID();

  await sql`insert into production.production_order (production_order_id, order_qty, status)
    values (${orderId}, 10, 'INPROGRESS')`;

  const pickListId = crypto.randomUUID();
  await sql`insert into production.material_pick_list (material_pick_list_id, production_order_id, status)
    values (${pickListId}, ${orderId}, 'ACTIVE')`;

  return { orderId, materialId, inventoryBatchId, pickListId };
}

test('issueMaterials: refuses an issue with no materialPickListId', async () => {
  const { orderId, materialId, inventoryBatchId } = await freshOrderWithPickList();
  await assert.rejects(
    () =>
      svc.issueMaterials(
        {
          productionOrderId: orderId,
          items: [{ materialId, inventoryBatchId }],
        } as never,
        principal(),
      ),
    BadRequestException,
  );
});

test('issueMaterials: succeeds and flips issued_qty when materialPickListId is present', async () => {
  const { orderId, materialId, inventoryBatchId, pickListId } = await freshOrderWithPickList();
  const sql = testClient();
  await sql`insert into production.production_order_ingredients
    (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, status)
    values (${crypto.randomUUID()}, ${orderId}, ${materialId}, 15, false, 'ACTIVE')`;

  const { issue, itemCount } = await svc.issueMaterials(
    {
      productionOrderId: orderId,
      materialPickListId: pickListId,
      items: [{ materialId, inventoryBatchId }],
    } as never,
    principal(),
  );
  assert.equal(itemCount, 1);
  assert.equal(issue.materialPickListId, pickListId);

  const ingredient = (
    await sql`select issued_qty from production.production_order_ingredients where production_order_id = ${orderId}`
  )[0]!;
  assert.equal(ingredient.issued_qty, true);
});

/* Golden journey lane/j2 — an instruction line with no floor code (the material has no RM
 * alias) is refused with the fix, never returned as `{ code: null }`. */
test('resolveManufacturingInstruction: refuses (409) when a line has no floor code, names only sequence numbers', async () => {
  const lookup: VaultPort = {
    ...stubFormulaLookup,
    async resolveManufacturingInstruction() {
      return [
        { code: 'RX-1', quantity: 1, uom: 'kg', sequenceNo: 1 },
        { code: null, quantity: 2, uom: 'kg', sequenceNo: 2 },
      ] as never;
    },
  };
  const coded = new PickingService(productionDb(), lookup);
  const orderId = crypto.randomUUID();
  await testClient()`insert into production.production_order (production_order_id, formula_version_id, order_qty, status)
    values (${orderId}, ${crypto.randomUUID()}, 3, 'INPROGRESS')`;
  await assert.rejects(
    () => coded.resolveManufacturingInstruction(orderId, principal()),
    (e: unknown) => e instanceof ConflictException && /sequence 2\b/.test((e as Error).message) && /RM alias/.test((e as Error).message),
  );
});

test('resolveManufacturingInstruction: a fully coded instruction is returned unchanged', async () => {
  const lines = [{ code: 'RX-1', quantity: 1, uom: 'kg', sequenceNo: 1 }];
  const coded = new PickingService(productionDb(), { ...stubFormulaLookup, async resolveManufacturingInstruction() { return lines as never; } });
  const orderId = crypto.randomUUID();
  await testClient()`insert into production.production_order (production_order_id, formula_version_id, order_qty, status)
    values (${orderId}, ${crypto.randomUUID()}, 1, 'INPROGRESS')`;
  assert.deepEqual(await coded.resolveManufacturingInstruction(orderId, principal()), lines);
});
