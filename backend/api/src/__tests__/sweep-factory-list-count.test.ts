/**
 * SWEEP-FACTORY: the generic list's count line (web/shell.js; no browser). With a search the rows
 * come from /v1/search (up to 200, whole table) but the count still divided by the loaded page:
 * "180 of 100". A search that hit the 200 cap said nothing, and with more pages to load the
 * headline read "100 Records" as if that were the total. Runs listCountText's own source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/shell.js'), 'utf8');

function load() {
  const start = js.indexOf('function listCountText(');
  assert.ok(start > 0, 'shell.js defines listCountText');
  const end = js.indexOf('\n  }\n', start) + 4;
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(js.slice(start, end) + '\nthis.f = listCountText;', ctx);
  return ctx.f as (shown: number, v: unknown, server: boolean) => string;
}

test('a server search result is never counted against the loaded page', () => {
  const f = load();
  assert.equal(f(180, { rows: new Array(100), cursor: 'c', serverRows: new Array(180) }, true), '180 matches');
  assert.match(f(200, { rows: new Array(100), cursor: 'c', serverRows: new Array(200) }, true), /first 200 matches/);
});

test('a page with more to load says so', () => {
  const f = load();
  assert.equal(f(100, { rows: new Array(100), cursor: 'c' }, false), '100 of 100 loaded, more to load');
  assert.equal(f(12, { rows: new Array(40), cursor: null }, false), '12 of 40');
});

test('the count line and Records headline use it', () => {
  assert.match(js, /cnt\.textContent = listCountText\(/);
  assert.match(js, /String\(rows\.length\) \+ \(cursor \? '\+' : ''\)/);
});
