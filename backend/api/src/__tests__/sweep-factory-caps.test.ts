/**
 * SWEEP-FACTORY: lists that stopped at a fixed size with nothing said (web/ws-mfg.js,
 * web/ws-produce.js, web/shell.js; no browser).
 *  - Unit dictionary (100), QC parameters (100), oil batches for a COA (100): now every page via
 *    fkRows, which also accepts a path that already carries a query string.
 *  - Dispatch batch picker: /v1/fg-stock pages now (fg-stock.service.ts), and the picker reads
 *    every page through fkRows.
 *  - Produce queue: the route shows up to 500 rows; its counters and `total` cover the whole queue
 *    (produce-queue.service.ts), and the screen says when more rows exist than are shown.
 *  - QC parameters: a failed list is said, not an empty picker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const shell = read('web/shell.js'), mfg = read('web/ws-mfg.js'), produce = read('web/ws-produce.js');

test('fkRows keeps a query string the path already has', async () => {
  const s = shell.indexOf('async function fkRows(');
  const seen: string[] = [];
  const ctx: Record<string, unknown> = { encodeURIComponent, tunnel: async (p: string) => { seen.push(p); return { status: 200, json: { data: [1], meta: {} } }; } };
  vm.createContext(ctx); vm.runInContext(shell.slice(s, shell.indexOf('\n  }\n', s) + 4) + '\nthis.f = fkRows;', ctx);
  await (ctx.f as (p: string) => Promise<unknown>)('/v1/x?a=1');
  assert.deepEqual(seen, ['/v1/x?a=1&limit=100']);
});

test('unit dictionary, QC parameters and oil batches read every page', () => {
  assert.match(shell, /fkRows\('\/v1\/uoms'\)/); assert.doesNotMatch(shell, /\/v1\/uoms\?limit=100/);
  assert.match(mfg, /fkRows\('\/v1\/qc-parameters'\)/); assert.doesNotMatch(mfg, /qc-parameters\?limit=100/);
  assert.match(mfg, /fkRows\('\/v1\/oil-batches'\)/); assert.doesNotMatch(mfg, /oil-batches\?limit=100/);
});

// SWEEP-FACTORY-8: /v1/fg-stock now pages and the produce queue's counters and total cover the
// whole queue on the server, so the picker reads every page and the tiles need no '+' or caveat.
test('the dispatch picker reads every page of stock; the queue says its server total', () => {
  assert.match(mfg, /fkRows\('\/v1\/fg-stock\?onlyAvailable=1'\)/); assert.doesNotMatch(mfg, /fg-stock\?onlyAvailable=1&limit=/);
  assert.doesNotMatch(mfg, /batches\.length >= 200/);
  assert.equal((produce.match(/produce\/queue\?limit=500/g) || []).length, 2);
  assert.match(produce, /d\.total > \(d\.items \|\| \[\]\)\.length/);
  assert.doesNotMatch(produce, /counts below cover these only/);
});
