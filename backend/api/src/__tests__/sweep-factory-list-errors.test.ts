/**
 * SWEEP-FACTORY: "Load more" and the whole-table search failed silently (web/shell.js; no browser).
 * A refused next page (status >= 400) was treated as the last page: the cursor was cleared, the
 * button vanished and the list looked complete. A failed search left only the loaded page filtered,
 * with nothing saying the rest of the table was not searched. Runs both functions' own source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/shell.js'), 'utf8');
function src(name: string) { const s = js.indexOf('async function ' + name + '('); assert.ok(s > 0, name); return js.slice(s, js.indexOf('\n  }\n', s) + 4); }

function run(name: string, res: unknown, search = '') {
  const toasts: string[] = []; const view = { item: [0, 0, 0, '/v1/x'], rows: [1], cursor: 'c1' };
  const ctx: Record<string, unknown> = {
    st: { _view: view, search }, $: () => null, paintResults: () => {}, encodeURIComponent,
    tunnel: async () => { if (res instanceof Error) throw res; return res; },
    toast: (m: string) => { toasts.push(m); },
  };
  vm.createContext(ctx); vm.runInContext(src(name) + '\nthis.f = ' + name + ';', ctx);
  return { go: () => (ctx.f as () => Promise<void>)(), toasts, view };
}

test('a refused next page keeps the cursor and tells the user', async () => {
  const r = run('loadMore', { status: 500, json: { error: { message: 'down' } } });
  await r.go();
  assert.equal(r.view.cursor, 'c1'); assert.equal(r.view.rows.length, 1); assert.equal(r.toasts.length, 1);
});

test('an unreachable next page tells the user', async () => {
  const r = run('loadMore', new Error('channel')); await r.go(); assert.equal(r.toasts.length, 1);
});

test('a failed whole-table search tells the user only the loaded rows were searched', async () => {
  const r = run('searchServer', { status: 500, json: null }, 'abc'); await r.go();
  assert.equal(r.toasts.length, 1); assert.match(r.toasts[0], /loaded/);
  const r2 = run('searchServer', new Error('channel'), 'abc'); await r2.go(); assert.equal(r2.toasts.length, 1);
});

test('with every row already loaded a failed search is not an error', async () => {
  const r = run('searchServer', { status: 404, json: null }, 'abc'); r.view.cursor = null as unknown as string; await r.go();
  assert.equal(r.toasts.length, 0);
});
