/**
 * Golden journey lane/j2 — the planner's incoming ALEMBIC-requirements queue
 * (`GET /v1/bridge/requirements`, RequirementsQueueService). Before this, nothing exposed
 * `bridge.production_requirement`, so a planner could not learn the `alembicRequirementId` to
 * link a production order to without SQL. Covers: rows listed oldest need first, the
 * `unlinked` filter drops a requirement a production order already claims, and the route
 * carries a real permission (production:production_order:read).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { RequirementsQueueService } from '../bridge/requirements-queue.service.js';
import { BridgeController } from '../bridge/bridge.controller.js';
import { META_PERMISSIONS } from '../../../backend-kernel/src/decorators/metadata.keys.js';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';

let svc: RequirementsQueueService;
const tag = randomUUID().slice(0, 8);

before(async () => {
  await ensureSchema();
  svc = new RequirementsQueueService(testClient());
  const sql = testClient();
  const insert = (orderRef: string, neededBy: string, productionOrderId: string | null) => sql`
    insert into bridge.production_requirement
      (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, lifecycle_status, production_order_id)
    values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${orderRef}, 'AVT-1KG', 1000000, 'mg', ${neededBy}, 'ACCEPTED', ${productionOrderId})`;
  await insert(`Q-${tag}-LATE`, '2099-02-01T00:00:00Z', null);
  await insert(`Q-${tag}-EARLY`, '2099-01-01T00:00:00Z', null);
  await insert(`Q-${tag}-LINKED`, '2099-01-15T00:00:00Z', randomUUID());
});
after(async () => {
  await closeTestClient();
});

test('requirements queue: lists every requirement, oldest need first', async () => {
  const mine = (await svc.list({ limit: 200 })).filter((r) => r.orderRef.startsWith(`Q-${tag}`));
  assert.deepEqual(mine.map((r) => r.orderRef), [`Q-${tag}-EARLY`, `Q-${tag}-LINKED`, `Q-${tag}-LATE`]);
  assert.equal(mine[0]!.mappedSku, 'AVT-1KG');
  assert.equal(mine[0]!.uom, 'mg');
});

test('requirements queue: unlinked=true drops a requirement a production order already claims', async () => {
  const mine = (await svc.list({ unlinkedOnly: true, limit: 200 })).filter((r) => r.orderRef.startsWith(`Q-${tag}`));
  assert.deepEqual(mine.map((r) => r.orderRef), [`Q-${tag}-EARLY`, `Q-${tag}-LATE`]);
});

test('requirements queue: the route is permission-gated on production_order:read', () => {
  const perms = new Reflector().get<string[]>(META_PERMISSIONS, BridgeController.prototype.listRequirements);
  assert.deepEqual(perms, ['production:production_order:read']);
});
