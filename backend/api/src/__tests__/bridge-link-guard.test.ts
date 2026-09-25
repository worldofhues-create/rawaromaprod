/**
 * Security review R1 #3 — PlanningService.createOrder's bridge requirement link
 * (backend/cluster-production/src/planning/planning.service.ts, ~line 224) used to match only
 * `alembic_requirement_id = :id AND production_order_id IS NULL`, with NO check on
 * `lifecycle_status`. That meant scheduling production against a requirement RawProd had
 * already REJECTED_MAPPING'd or the ALEMBIC side had CANCELLED would silently "succeed": the
 * UPDATE would match zero rows (a stale/mismatched id) or, worse, actually link an order to a
 * requirement that was never accepted — either way the caller got no signal anything was wrong,
 * because the code never checked how many rows the UPDATE touched.
 *
 * Fix: the UPDATE now also requires `lifecycle_status = 'ACCEPTED'` and the row count is
 * checked — zero rows throws ConflictException instead of silently no-opping.
 *
 * Covers: a REJECTED_MAPPING requirement, a CANCELLED one, an already-linked ACCEPTED one, and
 * an unknown/bad alembicRequirementId — all four must now throw ConflictException instead of
 * silently creating an unlinked (or wrongly linked) production order.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { PlanningService } from '../../../cluster-production/src/planning/planning.service.js';
import type { PickLine, VaultPort } from '../../../cluster-formula/src/vault-port.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

before(async () => {
  await ensureSchema();
});

after(async () => {
  await closeTestClient();
});

// The Vault's pick list, as VAULT_PORT hands it to PlanningService (material resolved on this box).
const stubVault: VaultPort = {
  async resolveManufacturingInstruction() {
    return null;
  },
  async resolvePickList(): Promise<PickLine[] | null> {
    return [{ materialId: crypto.randomUUID(), requiredQty: '10.0000', sequenceNo: 1 }];
  },
};

async function freshRequirement(lifecycleStatus: string, opts: { linked?: boolean } = {}): Promise<string> {
  const sql = testClient();
  const alembicRequirementId = crypto.randomUUID();
  const linkedOrderId = opts.linked ? crypto.randomUUID() : null;
  if (opts.linked) {
    await sql`insert into production.production_order (production_order_id, status) values (${linkedOrderId}, 'PLANNING')`;
  }
  await sql`insert into bridge.production_requirement
    (production_requirement_id, alembic_requirement_id, org_id, correlation_id, order_ref,
     mapped_sku, qty, uom, needed_by, lifecycle_status, production_order_id, last_applied_version, last_emitted_version)
    values (${crypto.randomUUID()}, ${alembicRequirementId}, ${crypto.randomUUID()}, ${crypto.randomUUID()},
     'ORD-1', 'SKU-1', 10, 'KG', now(), ${lifecycleStatus}, ${linkedOrderId}, 1, 0)`;
  return alembicRequirementId;
}

async function orderCountForRequirement(alembicRequirementId: string): Promise<number> {
  const sql = testClient();
  const rows = await sql`select production_order_id from bridge.production_requirement
                           where alembic_requirement_id = ${alembicRequirementId} and production_order_id is not null`;
  return rows.length;
}

test('planning.createOrder: a REJECTED_MAPPING requirement cannot be scheduled against — throws, nothing linked', async () => {
  const svc = new PlanningService(productionDb(), stubVault);
  const alembicRequirementId = await freshRequirement('REJECTED_MAPPING');

  await assert.rejects(
    () => svc.createOrder({ formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId }, principal()),
    ConflictException,
  );
  assert.equal(await orderCountForRequirement(alembicRequirementId), 0);
});

test('planning.createOrder: a CANCELLED requirement cannot be scheduled against — throws, nothing linked', async () => {
  const svc = new PlanningService(productionDb(), stubVault);
  const alembicRequirementId = await freshRequirement('CANCELLED');

  await assert.rejects(
    () => svc.createOrder({ formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId }, principal()),
    ConflictException,
  );
  assert.equal(await orderCountForRequirement(alembicRequirementId), 0);
});

test('planning.createOrder: an ACCEPTED requirement already linked to another order cannot be re-linked — throws', async () => {
  const svc = new PlanningService(productionDb(), stubVault);
  const alembicRequirementId = await freshRequirement('ACCEPTED', { linked: true });

  await assert.rejects(
    () => svc.createOrder({ formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId }, principal()),
    ConflictException,
  );
  // Still linked to exactly the original order, not stolen/duplicated.
  assert.equal(await orderCountForRequirement(alembicRequirementId), 1);
});

test('planning.createOrder: an unknown alembicRequirementId throws instead of silently creating an unlinked order', async () => {
  const svc = new PlanningService(productionDb(), stubVault);
  const badId = crypto.randomUUID();

  await assert.rejects(
    () => svc.createOrder({ formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId: badId }, principal()),
    ConflictException,
  );
});

test('planning.createOrder: happy path — an ACCEPTED, unlinked requirement links cleanly', async () => {
  const svc = new PlanningService(productionDb(), stubVault);
  const alembicRequirementId = await freshRequirement('ACCEPTED');

  const { order } = await svc.createOrder(
    { formulaVersionId: crypto.randomUUID(), orderQty: 10, alembicRequirementId },
    principal(),
  );

  const sql = testClient();
  const req = await sql`select production_order_id from bridge.production_requirement
                          where alembic_requirement_id = ${alembicRequirementId}`;
  assert.equal(req[0]!.production_order_id, order.productionOrderId);
});
