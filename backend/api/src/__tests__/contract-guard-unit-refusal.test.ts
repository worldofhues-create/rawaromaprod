/**
 * FLOOR-FIX-13 (Alembic doc 17 §5.6) — a requirement in a unit quantity.ts cannot convert (RAC's lots
 * count `unit`) is refused as a permanent 400. It used to be accepted (uom was free text), and then
 * could never complete: every receipt against it converts to null and the importer refuses to guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInboundPayload } from '../bridge/contract.js';
import { isConvertibleUnit } from '../bridge/quantity.js';

const created = (uom: string) => ({ order_ref: 'SO-1', mapped_sku: 'SKU-1', qty: '5', uom, needed_by: '2026-11-20' });

test('Created and Changed refuse a unit RawProd cannot convert; the convertible ones pass', () => {
  for (const u of ['unit', 'bottle', 'box', 'dozen']) {
    assert.ok(validateInboundPayload('ProductionRequirementCreated', created(u)).includes('uom:invalid'), u);
    assert.ok(validateInboundPayload('ProductionRequirementChanged', { qty: '5', uom: u }).includes('uom:invalid'), u);
    assert.equal(isConvertibleUnit(u), false);
  }
  for (const u of ['mg', 'g', 'KG', ' kg ', 't', 'ml', 'l', 'pcs', 'nos', 'ea']) {
    assert.deepEqual(validateInboundPayload('ProductionRequirementCreated', created(u)), [], u);
    assert.equal(isConvertibleUnit(u), true);
  }
});
