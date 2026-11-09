/**
 * FLOOR-FIX-8 (Alembic doc 17 §5.1) — `fg.batch.received.qty_kg` leaves RawProd with at most
 * 6 decimals. ALEMBIC refuses a float tail such as 0.30000000000000004 as a permanent error, and
 * RawProd parks the event, so the lot never reaches the shelf. 6 decimals of a kg is 1 mg: exact for
 * every weight the floor stores, where the old 4-decimal rounding dropped anything under 50 mg.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFgBatchReceived } from '../shelf/shelf-task.service.js';

const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;
const base = { batchNo: 'FG-1', sku: 'SKU-1', packSize: null, rack: 'R1-B2', releasedAt: '2026-11-10T09:00:00Z', qcBatchNo: 'OB-1' };

test('qty_kg is rounded to at most 6 decimals, exact to the mg', () => {
  const cases: Array<[number, string, number]> = [
    [0.1 + 0.2, 'kg', 0.3],
    [1234.567, 'g', 1.234567],
    [1, 'mg', 0.000001],
    [3 * 0.1, 'kg', 0.3],
  ];
  for (const [qty, uomCode, want] of cases) {
    const r = buildFgBatchReceived({ ...base, qty, uomCode });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.payload.qty_kg, want);
    assert.ok(decimals(r.payload.qty_kg) <= 6, `${r.payload.qty_kg} has more than 6 decimals`);
    assert.ok(!/e-/i.test(JSON.stringify(r.payload.qty_kg)) || r.payload.qty_kg < 1e-6, 'no exponent on the wire');
  }
  // A count with a mass pack size: 3 x 0.1 kg must not reach the wire as 0.30000000000000004.
  const p = buildFgBatchReceived({ ...base, qty: 3, uomCode: 'drum', packSize: '0.1 kg' });
  assert.ok(p.ok);
  assert.equal(p.payload.qty_kg, 0.3);
});
