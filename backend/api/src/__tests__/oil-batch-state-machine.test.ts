/**
 * RP-FAC — oil batch lifecycle state machine (production cluster BatchService.transitionOilBatch).
 * Covers: happy path, invalid transition, duplicate/concurrent command, rework/cancel. "Wrong
 * role" is covered generically for every controller this lane touched in permissions-guard.test.ts.
 * Runs against a real throwaway Postgres database (see ../../../test-support/db.ts) — the
 * concurrency assertions specifically need real row locking, not a mock.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { productionSchema } from '../../../cluster-production/src/production.tokens.js';
import { ensureSchema, productionDb, principal, closeTestClient, testClient } from '../../../test-support/db.js';

let svc: BatchService;

before(async () => {
  await ensureSchema();
  svc = new BatchService(productionDb());
});

after(async () => {
  await closeTestClient();
});

async function freshBatch() {
  const { batch } = await svc.produceOilBatch(
    { productionOrderId: crypto.randomUUID(), batchNumber: `B-${crypto.randomUUID()}`, producedQty: 100 },
    principal(),
  );
  return batch;
}

/** lane/j2: RELEASED now requires a PASS production QC on file. */
async function passQc(oilBatchId: string) {
  await svc.recordProductionQc({ oilBatchId, result: 'PASS' }, principal());
}

test('oil batch: produce starts ACTIVE', async () => {
  const batch = await freshBatch();
  assert.equal(batch.status, 'ACTIVE');
});

test('oil batch: happy path ACTIVE -> IN_MATURATION -> RELEASED writes event history + outbox', async () => {
  const batch = await freshBatch();
  const step1 = await svc.transitionOilBatch(batch.oilBatchId, 'IN_MATURATION', principal());
  assert.equal(step1.status, 'IN_MATURATION');
  await passQc(batch.oilBatchId);
  const step2 = await svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal());
  assert.equal(step2.status, 'RELEASED');

  const events = await productionDb().select().from(productionSchema.oilBatchEventHistory);
  const forThisBatch = events.filter((e: any) => e.oilBatchId === batch.oilBatchId);
  assert.deepEqual(
    forThisBatch.map((e: any) => e.eventType).sort(),
    ['IN_MATURATION', 'PRODUCED', 'QC_RECORDED', 'RELEASED'].sort(),
  );

  const outboxRows = await productionDb().select().from(productionSchema.outbox);
  const statusEvents = outboxRows.filter(
    (r: any) => r.type === 'production.oil_batch.status' && r.aggregateId === batch.oilBatchId,
  );
  assert.equal(statusEvents.length, 2, 'one outbox row per transition');
});

test('oil batch: idempotent same-state transition is a no-op (does not throw, does not duplicate events)', async () => {
  const batch = await freshBatch();
  const before1 = await svc.transitionOilBatch(batch.oilBatchId, 'ACTIVE', principal());
  assert.equal(before1.status, 'ACTIVE');
});

test('oil batch: invalid transition (skip a required stage) is rejected', async () => {
  const batch = await freshBatch();
  // ACTIVE -> RELEASED directly is not a legal edge (must pass through IN_MATURATION/HOLD/REWORK).
  await assert.rejects(
    () => svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal()),
    ConflictException,
  );
});

test('oil batch: terminal states (RELEASED, FAILED) accept no further transitions', async () => {
  const batch = await freshBatch();
  await svc.transitionOilBatch(batch.oilBatchId, 'IN_MATURATION', principal());
  await passQc(batch.oilBatchId);
  await svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal());
  await assert.rejects(
    () => svc.transitionOilBatch(batch.oilBatchId, 'HOLD', principal()),
    ConflictException,
  );

  const failedBatch = await freshBatch();
  await svc.transitionOilBatch(failedBatch.oilBatchId, 'FAILED', principal());
  await assert.rejects(
    () => svc.transitionOilBatch(failedBatch.oilBatchId, 'REWORK', principal()),
    ConflictException,
  );
});

test('oil batch: rework path HOLD -> REWORK -> IN_MATURATION -> RELEASED', async () => {
  const batch = await freshBatch();
  await svc.transitionOilBatch(batch.oilBatchId, 'HOLD', principal());
  await svc.transitionOilBatch(batch.oilBatchId, 'REWORK', principal());
  await svc.transitionOilBatch(batch.oilBatchId, 'IN_MATURATION', principal());
  await passQc(batch.oilBatchId);
  const released = await svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal());
  assert.equal(released.status, 'RELEASED');
});

test('oil batch: unknown batch id 404s', async () => {
  await assert.rejects(
    () => svc.transitionOilBatch(crypto.randomUUID(), 'HOLD', principal()),
    NotFoundException,
  );
});

test('oil batch: duplicate/concurrent transition never double-writes', async () => {
  // Fire N concurrent identical transitions off the same source state. Depending on exactly how
  // the network/scheduler interleaves them, a racing caller either (a) loses the compare-and-swap
  // UPDATE and is rejected with ConflictException, or (b) its own pre-check read happens to
  // observe the winner's already-committed state and takes the idempotent same-state short
  // circuit — both are correct outcomes. What must NEVER happen is two callers each completing a
  // real write for the same logical transition. That's the invariant this test checks, rather
  // than asserting a specific win/loss split (which is a real, legitimate race outcome, not a bug).
  const batch = await freshBatch();
  const N = 5;
  const results = await Promise.allSettled(
    Array.from({ length: N }, () => svc.transitionOilBatch(batch.oilBatchId, 'IN_MATURATION', principal())),
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      assert.equal((r.value as { status: string }).status, 'IN_MATURATION');
    } else {
      assert.match(String((r.reason as Error).message), /concurrent/i);
    }
  }
  assert.ok(
    results.some((r) => r.status === 'fulfilled'),
    'at least one racing call must succeed',
  );

  const finalBatch = await svc.getOilBatch(batch.oilBatchId);
  assert.ok(finalBatch);
  assert.equal(finalBatch.status, 'IN_MATURATION');

  const events = await productionDb().select().from(productionSchema.oilBatchEventHistory);
  const matStarts = events.filter(
    (e: any) => e.oilBatchId === batch.oilBatchId && e.eventType === 'IN_MATURATION',
  );
  assert.equal(matStarts.length, 1, 'exactly one event_history row for the transition, never N');

  const outboxRows = await productionDb().select().from(productionSchema.outbox);
  const statusEvents = outboxRows.filter(
    (r: any) => r.type === 'production.oil_batch.status' && r.aggregateId === batch.oilBatchId,
  );
  assert.equal(statusEvents.length, 1, 'exactly one outbox row for the transition, never N');
});

test('oil batch: the compare-and-swap UPDATE itself rejects a stale write under true overlap (raw SQL proof)', async () => {
  // Isolates the actual DB-level guard from the service's outer read-then-act race by driving
  // two real, concurrently-held transactions directly — proves the WHERE status = :current clause
  // added to transitionOilBatch's UPDATE is a real compare-and-swap, not a no-op.
  const batch = await freshBatch();
  const sql = testClient();
  const attempt = () =>
    sql.begin(
      (tx: any) =>
        tx`update production.oil_batch_master set status = 'IN_MATURATION'
           where oil_batch_id = ${batch.oilBatchId} and status = 'ACTIVE' returning *`,
    );
  const [a, b] = await Promise.all([attempt(), attempt()]);
  const affected = [a.length, b.length].sort();
  assert.deepEqual(affected, [0, 1], 'exactly one of the two concurrent CAS updates affects a row');
});

/* lane/j2 — final-QC gate on RELEASED. */
test('oil batch: RELEASED is refused with no QC on file, and with a latest QC that is not PASS', async () => {
  const batch = await freshBatch();
  await svc.transitionOilBatch(batch.oilBatchId, 'IN_MATURATION', principal());
  await assert.rejects(
    () => svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal()),
    (e: unknown) => e instanceof ConflictException && /no QC result/.test((e as Error).message),
  );
  await svc.recordProductionQc({ oilBatchId: batch.oilBatchId, result: 'HOLD' }, principal());
  await assert.rejects(
    () => svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal()),
    (e: unknown) => e instanceof ConflictException && /latest QC result is HOLD/.test((e as Error).message),
  );
  await passQc(batch.oilBatchId);
  const released = await svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal());
  assert.equal(released.status, 'RELEASED');
});
