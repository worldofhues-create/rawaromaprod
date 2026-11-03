/**
 * SWEEP-FACTORY: create/edit form pickers (web/shell.js; no browser). Every foreign-key dropdown
 * (materials, vendors, UoMs, purchase orders, batches...) loaded `fk?limit=100` and stopped, so with
 * a realistic raw-material master (500+ rows) an older material or vendor could not be chosen at
 * all, and a refused or unreachable list left an empty dropdown with nothing said. fkRows follows
 * meta.cursor; runs its own source against a fake tunnel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/shell.js'), 'utf8');

function load(pages: Record<string, unknown>) {
  const s = js.indexOf('async function fkRows(');
  assert.ok(s > 0, 'shell.js defines fkRows');
  const ctx: Record<string, unknown> = {
    encodeURIComponent,
    tunnel: async (p: string) => { const r = pages[p]; if (r instanceof Error) throw r; return r || { status: 500, json: { error: { message: 'down' } } }; },
  };
  vm.createContext(ctx);
  vm.runInContext(js.slice(s, js.indexOf('\n  }\n', s) + 4) + '\nthis.f = fkRows;', ctx);
  return ctx.f as (p: string) => Promise<{ rows: unknown[]; error: string | null }>;
}

test('a picker reads every page of its list', async () => {
  const f = load({
    '/v1/materials?limit=100': { status: 200, json: { data: [1, 2], meta: { cursor: 'a' } } },
    '/v1/materials?limit=100&cursor=a': { status: 200, json: { data: [3], meta: {} } },
  });
  const r = await f('/v1/materials');
  assert.equal(JSON.stringify(r), JSON.stringify({ rows: [1, 2, 3], error: null }));
});

test('a refused or unreachable list is reported, not an empty dropdown', async () => {
  assert.equal((await load({})('/v1/vendors')).error, 'down');
  assert.ok((await load({ '/v1/vendors?limit=100': new Error('channel') })('/v1/vendors')).error);
});

test('both form builders use fkRows and show its error', () => {
  assert.equal((js.match(/fkRows\(f\.fk\)\.then/g) || []).length, 2);
  assert.doesNotMatch(js, /tunnel\(f\.fk \+ '\?limit=100'\)/);
});
