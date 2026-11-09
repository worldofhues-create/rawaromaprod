/**
 * FLOOR-FIX-9 (Alembic doc 17 §5.4) — every `fg.batch.received` for a COMPOUNDED batch (one made
 * from an oil batch) carries `qc_batch_no`. ALEMBIC releases the lot against that QC batch; without
 * it the lot is held there forever. Such a payload is not sent: the put-away raises the
 * fg_received_not_sent alert naming the field instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFgBatchReceived } from '../shelf/shelf-task.service.js';

const base = { batchNo: 'FG-1', sku: 'SKU-1', packSize: null, qty: 2, uomCode: 'kg', rack: 'R1-B2', releasedAt: '2026-11-10T09:00:00Z' };

test('a compounded batch always carries qc_batch_no; one without it is refused, not sent', () => {
  const ok = buildFgBatchReceived({ ...base, compounded: true, qcBatchNo: 'OB-0042' });
  assert.ok(ok.ok);
  assert.equal(ok.payload.qc_batch_no, 'OB-0042');
  for (const qcBatchNo of [null, undefined, '']) {
    const r = buildFgBatchReceived({ ...base, compounded: true, qcBatchNo });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.problems.some((p) => p.startsWith('qc_batch_no')), JSON.stringify(r));
  }
  // A batch not made from an oil batch (bought-in, repacked) has no QC batch to name.
  const plain = buildFgBatchReceived({ ...base, compounded: false, qcBatchNo: null });
  assert.ok(plain.ok);
  assert.equal('qc_batch_no' in plain.payload, false);
});
