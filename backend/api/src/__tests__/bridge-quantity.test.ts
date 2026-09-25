import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertQty } from '../bridge/quantity.js';

test('convertQty: mass and volume convert within their dimension, case-insensitively', () => {
  assert.equal(convertQty(1, 'kg', 'mg'), 1_000_000);
  assert.equal(convertQty(250, 'g', 'KG'), 0.25);
  assert.equal(convertQty(1.5, 'l', 'ml'), 1500);
  assert.equal(convertQty(7, 'mg', 'mg'), 7);
  assert.equal(convertQty(3, 'CUSTOM-X', 'custom-x'), 3);
});

test('convertQty: unknown units and cross-dimension pairs are refused (null)', () => {
  assert.equal(convertQty(1, 'kg', 'l'), null);
  assert.equal(convertQty(1, 'kg', 'drum'), null);
  assert.equal(convertQty(Number.NaN, 'kg', 'mg'), null);
});
