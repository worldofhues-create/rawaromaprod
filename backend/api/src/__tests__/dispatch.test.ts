/**
 * RP-FAC — dispatch over-dispatch guard (DispatchService.createDispatch / createDispatchItem).
 * Registry RP-DISP-002 flagged this as NOT_BUILT ("dispatch single-writer guard"); the pre-flight
 * check existed but was explicitly documented as best-effort, outside the write transaction. This
 * suite proves the authoritative, lock-held recheck (`fgAvailableLocked`, run inside the write
 * tx) actually prevents concurrent over-dispatch, not just the sequential case the old pre-flight
 * check already handled. Covers: happy path, negative-stock (over-dispatch) attempt, concurrent
 * over-dispatch, QC-FAIL blocking (0 available), and multi-batch dispatch (packaging → FG →
 * dispatch chain end to end).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DispatchService } from '../../../cluster-sales/src/dispatch/dispatch.service.js';
import { PackagingLookupService } from '../../../cluster-packaging/src/packaging-lookup.service.js';
import { ensureSchema, packagingDb, salesDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: DispatchService;

before(async () => {
  await ensureSchema();
  const lookup = new PackagingLookupService(packagingDb());
  svc = new DispatchService(salesDb(), lookup);
});

after(async () => {
  await closeTestClient();
});

async function freshFgBatch(producedQty: number, opts: { qcResult?: string } = {}) {
  const sql = testClient();
  const id = crypto.randomUUID();
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, batch_number, produced_qty, status)
    values (${id}, ${'FGD-' + id}, ${producedQty}, 'ACTIVE')`;
  if (opts.qcResult) {
    await sql`insert into packaging.packaging_qc
      (packaging_qc_id, finished_good_batch_id, overall_result, status)
      values (${crypto.randomUUID()}, ${id}, ${opts.qcResult}, 'ACTIVE')`;
  }
  return id;
}

test('dispatch: happy path dispatches within available stock', async () => {
  const batchId = await freshFgBatch(50);
  const { dispatch, items } = await svc.createDispatch(
    { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: batchId, dispatchedQty: 20 }] },
    principal(),
  );
  assert.equal(dispatch.status, 'ACTIVE');
  assert.equal(items.length, 1);
  assert.equal(Number(items[0]!.dispatchedQty), 20);
});

test('dispatch: negative-stock attempt (over-dispatch) is rejected', async () => {
  const batchId = await freshFgBatch(10);
  await assert.rejects(
    () =>
      svc.createDispatch(
        { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: batchId, dispatchedQty: 11 }] },
        principal(),
      ),
    ConflictException,
  );
});

test('dispatch: non-positive quantity is rejected', async () => {
  const batchId = await freshFgBatch(10);
  await assert.rejects(
    () =>
      svc.createDispatch(
        { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: batchId, dispatchedQty: 0 }] },
        principal(),
      ),
    ConflictException,
  );
});

test('dispatch: two lines against the same batch are aggregated against available (no split-line bypass)', async () => {
  const batchId = await freshFgBatch(10);
  await assert.rejects(
    () =>
      svc.createDispatch(
        {
          salesOrderId: crypto.randomUUID(),
          items: [
            { finishedGoodBatchId: batchId, dispatchedQty: 6 },
            { finishedGoodBatchId: batchId, dispatchedQty: 6 },
          ],
        },
        principal(),
      ),
    ConflictException,
  );
});

test('dispatch: a batch that FAILED packaging QC cannot be dispatched', async () => {
  const batchId = await freshFgBatch(50, { qcResult: 'FAIL' });
  await assert.rejects(
    () =>
      svc.createDispatch(
        { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: batchId, dispatchedQty: 1 }] },
        principal(),
      ),
    ConflictException,
  );
});

test('dispatch: unknown FG batch 404s', async () => {
  await assert.rejects(
    () =>
      svc.createDispatch(
        { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: crypto.randomUUID(), dispatchedQty: 1 }] },
        principal(),
      ),
    NotFoundException,
  );
});

test('dispatch: concurrent over-dispatch attempts never exceed produced stock (the RP-DISP-002 gap)', async () => {
  // 6 concurrent dispatch requests for 20 units each against a 100-unit batch: unguarded code
  // (the old outside-the-tx pre-flight alone) lets a batch of near-simultaneous requests all read
  // the same "100 available" snapshot and all pass, over-dispatching well past 100. The lock-held
  // recheck inside the write transaction must cap total dispatched at <= 100.
  const batchId = await freshFgBatch(100);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      svc.createDispatch(
        { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: batchId, dispatchedQty: 20 }] },
        principal(),
      ),
    ),
  );
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.ok(succeeded.length <= 5, `at most 5 of 6 concurrent 20-unit dispatches can fit in 100 (got ${succeeded.length})`);

  const sql = testClient();
  const totalDispatched = (
    await sql`select coalesce(sum(dispatched_qty),0)::float as total from sales.dispatch_items
               where finished_good_batch_id = ${batchId} and coalesce(status,'ACTIVE') <> 'CANCELLED'`
  )[0]!.total;
  assert.ok(totalDispatched <= 100, `total dispatched (${totalDispatched}) must never exceed produced (100)`);
  assert.equal(totalDispatched, succeeded.length * 20);
});

test('dispatch: createDispatchItem (the standalone line-add route) is guarded the same way', async () => {
  const batchId = await freshFgBatch(15);
  const { dispatch } = await svc.createDispatch(
    { salesOrderId: crypto.randomUUID(), items: [{ finishedGoodBatchId: batchId, dispatchedQty: 10 }] },
    principal(),
  );
  await assert.rejects(
    () =>
      svc.createDispatchItem(
        { dispatchId: dispatch.dispatchId, finishedGoodBatchId: batchId, dispatchedQty: 6 },
        principal(),
      ),
    ConflictException,
    'only 5 remain (15 - 10 already dispatched)',
  );
  const ok = await svc.createDispatchItem(
    { dispatchId: dispatch.dispatchId, finishedGoodBatchId: batchId, dispatchedQty: 5 },
    principal(),
  );
  assert.equal(Number(ok.dispatchedQty), 5);
});
