/**
 * OPS-GREEN Act L (lane ops-factory) — production QC -> maturation -> FINAL QC -> release.
 * The in-process PASS recorded before maturation does not release a matured batch; a PASS
 * recorded after it entered maturation does. Real Postgres.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { ensureSchema, productionDb, principal, closeTestClient } from '../../../test-support/db.js';

let svc: BatchService;
before(async () => { await ensureSchema(); svc = new BatchService(productionDb()); });
after(async () => { await closeTestClient(); });

test('a pre-maturation PASS does not release a matured batch; a final PASS after maturation does', async () => {
  const { batch } = await svc.produceOilBatch(
    { productionOrderId: crypto.randomUUID(), batchNumber: `FQ-${crypto.randomUUID()}`, producedQty: 10 }, principal());
  await svc.recordProductionQc({ oilBatchId: batch.oilBatchId, result: 'PASS' }, principal()); // in-process QC
  await new Promise((r) => setTimeout(r, 20));
  await svc.transitionOilBatch(batch.oilBatchId, 'IN_MATURATION', principal());
  await assert.rejects(() => svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal()),
    (e: unknown) => e instanceof ConflictException && /no final QC recorded since/.test((e as Error).message));
  await svc.recordProductionQc({ oilBatchId: batch.oilBatchId, result: 'PASS' }, principal()); // final QC
  const released = await svc.transitionOilBatch(batch.oilBatchId, 'RELEASED', principal());
  assert.equal(released.status, 'RELEASED');
});
