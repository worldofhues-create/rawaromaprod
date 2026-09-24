/**
 * Golden journey lane/j2 — auto-assigned RM batch numbers must not collide for two GRNs received
 * close together. They were `RMB-` + the first 8 hex of a uuidv7, i.e. the top 32 bits of the
 * millisecond timestamp: every GRN inside the same ~65 s window got the SAME number, and the
 * second receipt failed with a 500 on `rm_batch_master_number_uq` (hit live: two lots received a
 * minute apart).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortId } from '../../../cluster-inventory/src/grn/grn.service.js';

test('RM batch number suffix: 5,000 back-to-back ids in the same instant are all distinct', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) seen.add(shortId());
  assert.equal(seen.size, 5000);
});

test('RM batch number suffix: 12 upper-case hex characters (fits batch_number varchar(50) with the RMB- prefix)', () => {
  assert.match(shortId(), /^[0-9A-F]{12}$/);
});
