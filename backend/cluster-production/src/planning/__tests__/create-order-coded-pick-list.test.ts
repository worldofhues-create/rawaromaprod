/**
 * PlanningService.createOrder against `VAULT_PORT.resolvePickList` (lane vaultport-rp). Real
 * Postgres (backend/test-support); the port is a stub here — its main-box implementation
 * (ProductionVaultPort: keyed references -> this box's materials) is production-vault-port.test.ts,
 * the signed HTTP half vault-port-http-client.test.ts, and the whole two-process path
 * vault-isolation-harness.test.ts.
 *
 * Proves: the order asks the Vault for its bill of materials with the order quantity and the caller
 * as actor; one production_order_ingredients row per line, in order, with the Vault's required
 * quantity stored as given; no pick list (unknown/unapproved version) stays a 403; a refusal from
 * the port (e.g. a material this factory does not know, 409) creates nothing.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PickLine, ReadContext, VaultPort } from '@ra/cluster-formula';
import { PlanningService } from '../planning.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../../test-support/db.js';

let calls: Array<{ formulaVersionId: string; orderQty: number; ctx: ReadContext }> = [];
let next: () => Promise<PickLine[] | null> = async () => null;

const vault: VaultPort = {
  async resolveManufacturingInstruction() {
    return null;
  },
  async resolvePickList(formulaVersionId, orderQty, ctx) {
    calls.push({ formulaVersionId, orderQty, ctx });
    return next();
  },
};

let svc: PlanningService;

before(async () => {
  await ensureSchema();
  svc = new PlanningService(productionDb(), vault);
});

afterAll(async () => {
  await closeTestClient();
});

async function ordersFor(formulaVersionId: string): Promise<number> {
  const rows = await testClient()`select 1 from production.production_order where formula_version_id = ${formulaVersionId}`;
  return rows.length;
}

test('createOrder: one ingredient row per Vault line, in order, with the Vault\'s required quantity', async () => {
  const m1 = randomUUID();
  const m2 = randomUUID();
  next = async () => [
    { materialId: m1, requiredQty: '2.4333', sequenceNo: 1 },
    { materialId: m2, requiredQty: '4.8667', sequenceNo: 2 },
  ];
  calls = [];
  const formulaVersionId = randomUUID();
  const actor = principal();
  const { order, ingredientCount } = await svc.createOrder({ formulaVersionId, orderQty: 7.3 }, actor);

  assert.deepEqual(calls, [{ formulaVersionId, orderQty: 7.3, ctx: { actorId: actor.userId } }]);
  assert.equal(ingredientCount, 2);
  const rows = await testClient()<{ material_id: string; required_qty: string }[]>`
    select material_id::text, required_qty::text from production.production_order_ingredients
     where production_order_id = ${order.productionOrderId} order by production_order_ingredient_id`;
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { material_id: m1, required_qty: '2.4333' },
    { material_id: m2, required_qty: '4.8667' },
  ]);
});

test('createOrder: no pick list from the Vault (unknown/unapproved version) is a 403, nothing created', async () => {
  next = async () => null;
  const formulaVersionId = randomUUID();
  await assert.rejects(() => svc.createOrder({ formulaVersionId, orderQty: 1 }, principal()), ForbiddenException);
  assert.equal(await ordersFor(formulaVersionId), 0);
});

test('createOrder: a refusal from the port (a material this factory does not know) creates nothing', async () => {
  next = async () => {
    throw new ConflictException('1 formula line(s) (sequence 4) name a material this factory\'s master data does not have');
  };
  const formulaVersionId = randomUUID();
  await assert.rejects(() => svc.createOrder({ formulaVersionId, orderQty: 1 }, principal()), ConflictException);
  assert.equal(await ordersFor(formulaVersionId), 0);
});
