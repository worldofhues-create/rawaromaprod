/**
 * pick-quantity.ts — the required quantity the Vault now computes for each production-order
 * line must be EXACTLY what the main box used to store when it computed it itself:
 * `String((orderQty * percentage) / 100)` written into `required_qty numeric(18,4)`, rounded by
 * Postgres. Checked against Postgres's own cast, on edge cases and on thousands of random
 * (orderQty, percentage) pairs, so "same pick list as before" is proved, not assumed.
 */
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { PICK_QUANTITY_SCALE, pickLineRequiredQty, roundDecimalHalfAwayFromZero } from '../pick-quantity.js';
import { testClient, closeTestClient } from './db.js';

afterAll(async () => {
  await closeTestClient();
});

/** What the main box stored before: Postgres's numeric(18,4) of the old JS text. */
async function postgresStored(pairs: Array<[number, number]>): Promise<string[]> {
  const texts = pairs.map(([q, p]) => String((q * p) / 100));
  const rows = await testClient()<{ r: string }[]>`
    select v::numeric(18,4)::text as r from unnest(${texts}::text[]) with ordinality as t(v, i) order by i`;
  return rows.map((row) => row.r);
}

test('the scale is required_qty\'s: numeric(18,4)', () => {
  assert.equal(PICK_QUANTITY_SCALE, 4);
});

test('rounds half away from zero on the decimal text, like Postgres (not on the binary value)', () => {
  // 1.23455 is stored in binary as 1.2345499999…; toFixed(4) would say 1.2345, Postgres says 1.2346.
  assert.equal(roundDecimalHalfAwayFromZero(1.23455, 4), '1.2346');
  assert.equal(roundDecimalHalfAwayFromZero(-1.23455, 4), '-1.2346');
  assert.equal(roundDecimalHalfAwayFromZero(2.5, 0), '3');
  assert.equal(roundDecimalHalfAwayFromZero(0.00005, 4), '0.0001');
  assert.equal(roundDecimalHalfAwayFromZero(0.00004999, 4), '0.0000');
  assert.equal(roundDecimalHalfAwayFromZero(1e-7, 4), '0.0000');
  assert.equal(roundDecimalHalfAwayFromZero(12, 4), '12.0000');
  assert.equal(roundDecimalHalfAwayFromZero(1e21, 4), '1000000000000000000000.0000');
  assert.throws(() => roundDecimalHalfAwayFromZero(Number.NaN, 4), RangeError);
});

test('edge cases match what Postgres stored from the old computation', async () => {
  const pairs: Array<[number, number]> = [
    [10, 100], [7.3, 33.33333], [7.3, 12.34567], [100, 12.34565], [3, 33.333333333],
    [0.001, 0.00001], [2500, 0.0002], [1, 1.23455], [123.45, 67.891], [999999.9999, 99.9999],
    [0.5, 0.01], [50, 10], [10, 25], [1e-3, 5e-3],
  ];
  const expected = await postgresStored(pairs);
  assert.deepEqual(pairs.map(([q, p]) => pickLineRequiredQty(q, p)), expected);
});

test('5,000 random (orderQty, percentage) pairs match what Postgres stored from the old computation', async () => {
  let seed = 0x5eed1234;
  const rand = () => {
    // xorshift32: deterministic, so a failure reproduces.
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  const decimals = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < 5000; i++) {
    const orderQty = decimals(rand() * 10 ** Math.floor(rand() * 7), Math.floor(rand() * 5));
    const percentage = decimals(rand() * 100, Math.floor(rand() * 9));
    pairs.push([orderQty || 1, percentage]);
  }
  const expected = await postgresStored(pairs);
  const actual = pairs.map(([q, p]) => pickLineRequiredQty(q, p));
  const mismatches = actual
    .map((a, i) => ({ a, e: expected[i], pair: pairs[i] }))
    .filter((x) => x.a !== x.e);
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} mismatches`);
});
