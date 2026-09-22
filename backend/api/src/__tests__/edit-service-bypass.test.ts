/**
 * RP-FAC — regression test for the closed oil-batch generic-editor bypass (registry RP-PROD-004 /
 * audit H-C6 follow-up). `PATCH /v1/masters/oil-batches/:id` used to accept an arbitrary `status`
 * value with only a permission check — no OIL_TRANSITIONS validation, no event_history row, no
 * outbox event — letting a caller jump straight from FAILED to RELEASED. edit.service.ts's
 * registry entry for `oil-batches` now has an empty `cols` map, so the route is fully disabled:
 * this proves it stays that way.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { EditService } from '../edit/edit.service.js';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let editSvc: EditService;
let batchSvc: BatchService;

before(async () => {
  await ensureSchema();
  editSvc = new EditService(testClient());
  batchSvc = new BatchService(productionDb());
});

after(async () => {
  await closeTestClient();
});

test('edit-service: PATCH v1/masters/oil-batches/:id cannot set status (or anything else)', async () => {
  const { batch } = await batchSvc.produceOilBatch(
    { productionOrderId: crypto.randomUUID(), batchNumber: 'EDIT-' + crypto.randomUUID(), producedQty: 5 },
    principal(),
  );
  await batchSvc.transitionOilBatch(batch.oilBatchId, 'FAILED', principal());

  // The bypass this used to allow: FAILED -> RELEASED directly, skipping OIL_TRANSITIONS.
  await assert.rejects(
    () => editSvc.update('oil-batches', batch.oilBatchId, { status: 'RELEASED' }, principal()),
    BadRequestException,
  );

  const stillFailed = await batchSvc.getOilBatch(batch.oilBatchId);
  assert.ok(stillFailed);
  assert.equal(stillFailed.status, 'FAILED', 'status must be unchanged by the disabled editor route');
});

test('edit-service: an editable resource (e.g. vendors) still works — the registry itself is not broken', async () => {
  const sql = testClient();
  await sql.unsafe(`create schema if not exists procurement`);
  await sql.unsafe(`create table if not exists procurement.vendor_details (
    vendor_id uuid primary key, vendor_name varchar(200), status varchar(30),
    created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
    created_by varchar(255), updated_by varchar(255))`);
  const id = crypto.randomUUID();
  await sql`insert into procurement.vendor_details (vendor_id, vendor_name, status) values (${id}, 'Acme', 'ACTIVE')`;
  const updated = (await editSvc.update('vendors', id, { vendorName: 'Acme Renamed' }, principal({
    permissions: ['procurement:vendor_details:write'],
  }))) as { vendor_name: string };
  assert.equal(updated.vendor_name, 'Acme Renamed');
});

/**
 * Lane F5 (RP-DEADTABLES): these five REGISTRY entries target tables that do not exist in any
 * real database (see the guard test in backend/test-support/schema-guard.test.ts for the full
 * list + reasons). Before this fix, update() would issue a raw `update <schema>.<table> ...`
 * against a nonexistent relation and the caller got an unhandled 500 PostgresError. Now `cfg.
 * unavailable` short-circuits to an honest NotImplementedException, checked BEFORE the permission
 * check (never let a caller conclude they lack permission when the feature doesn't exist at all).
 */
for (const [resource, perm] of [
  ['documents', 'platform:document_master:write'],
  ['dispatch-documents', 'sales:dispatch_master:write'],
  ['po-advance-payments', 'procurement:purchase_order:write'],
  ['vendor-dispatches', 'procurement:purchase_order:read'],
  ['vendor-negotiations', 'procurement:quotation_items:write'],
] as const) {
  test(`edit-service: ${resource} is honestly unavailable (its backing table does not exist), not a 500`, async () => {
    await assert.rejects(
      () => editSvc.update(resource, crypto.randomUUID(), { status: 'ACTIVE' }, principal({ permissions: [perm] })),
      NotImplementedException,
    );
  });

  test(`edit-service: ${resource} refuses before checking permission (no perm at all still gets the honest message, not Forbidden)`, async () => {
    await assert.rejects(
      () => editSvc.update(resource, crypto.randomUUID(), { status: 'ACTIVE' }, principal({ permissions: [] })),
      NotImplementedException,
    );
  });
}
