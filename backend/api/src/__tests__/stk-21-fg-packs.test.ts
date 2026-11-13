/**
 * STOCK-FIX-RP (STK-21; Alembic's docs/plan/stock-bridge-contract.md section 2): `fg.batch.received`
 * names the packs, `pack_count` and `pack_net_mg`, when the SKU's pack is a MASS on file and the
 * quantity is a whole number of packs. Both or neither; their product is qty_kg in mg exactly; a
 * volume is never sent as a mass; today's six-field message is unchanged when there is no mass pack.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridge as contracts } from '@core/contracts';
import { buildFgBatchReceived } from '../shelf/shelf-task.service.js';

const base = { batchNo: 'FG-B6-0001', sku: 'abf', rack: 'R-B3-S2', releasedAt: '2026-11-13T10:00:00.000Z' };

test('nine 100 g bottles: pack_count 9, pack_net_mg 100000, qty_kg 0.9, and the contract\'s validator agrees', () => {
  const r = buildFgBatchReceived({ ...base, packSize: '100 g', qty: 9, uomCode: 'pcs', packNetMg: 100_000 });
  assert.ok(r.ok);
  assert.deepEqual({ c: r.payload.pack_count, n: r.payload.pack_net_mg, kg: r.payload.qty_kg }, { c: 9, n: 100_000, kg: 0.9 });
  assert.deepEqual(contracts.validateFgBatchReceived(r.payload), []);
});

test('no mass pack on file, a volume, or a part of a pack: neither field, exactly as today', () => {
  for (const [packSize, qty, uomCode, packNetMg] of [['25 kg', 4, 'DRUM', null], ['50 ml', 3, 'kg', null], ['100 g', 2.55, 'kg', 100_000]] as const) {
    const r = buildFgBatchReceived({ ...base, packSize, qty, uomCode, packNetMg });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal('pack_count' in r.payload, false);
    assert.equal('pack_net_mg' in r.payload, false);
  }
});

test('the validator refuses one field alone, a non-whole pack, and a product that is not qty_kg', () => {
  const p = { batch_no: 'B', sku: 'S', pack_size: '100 g', qty_kg: 0.9, rack: 'R', released_at: '2026-11-13T10:00:00.000Z' };
  assert.ok(contracts.validateFgBatchReceived({ ...p, pack_count: 9 }).some((x) => /both or neither/.test(x)));
  assert.ok(contracts.validateFgBatchReceived({ ...p, pack_count: 9, pack_net_mg: 100_000.5 }).includes('pack_net_mg'));
  assert.ok(contracts.validateFgBatchReceived({ ...p, pack_count: 8, pack_net_mg: 100_000 }).some((x) => /not qty_kg/.test(x)));
});
