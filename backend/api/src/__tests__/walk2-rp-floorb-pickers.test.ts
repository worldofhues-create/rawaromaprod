/**
 * WALK2-RP-4: Receiving audit, Supplier payments, QC checkpoints and Batch QC (web/ws-floorb.js) filled
 * their pickers from one page of 100, so at factory scale every older PO and batch could not be chosen,
 * and a refused or unreachable list read as an empty one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/ws-floorb.js'), 'utf8');
function load(tunnel: (p: string) => Promise<unknown>) {
  const s = js.indexOf('  function data(res)');
  const e = js.indexOf('  /* ── navigation');
  const ctx: Record<string, unknown> = { tunnel, escHtml: (x: string) => String(x), failText: undefined };
  vm.createContext(ctx);
  vm.runInContext(js.slice(s, e) + '\nthis.getRows = getRows; this.pick = pick;', ctx);
  return ctx as { getRows: (p: string) => Promise<any[] & { failed?: string }>; pick: (...a: unknown[]) => string };
}

test('every page is read', async () => {
  const pages: Record<string, unknown> = {
    '/v1/oil-batches?limit=100': { status: 200, json: { data: [{ id: 1 }], meta: { cursor: 'c2' } } },
    '/v1/oil-batches?limit=100&cursor=c2': { status: 200, json: { data: [{ id: 2 }], meta: { cursor: null } } },
  };
  const { getRows } = load(async (p) => pages[p]);
  const rows = await getRows('/v1/oil-batches?limit=100');
  assert.equal(JSON.stringify(rows.map((r) => r.id)), "[1,2]");
  assert.equal(rows.failed, undefined);
});
test('a refused list is said under the picker, not shown as empty', async () => {
  const { getRows, pick } = load(async () => ({ status: 403, json: { error: { message: 'Not allowed' } } }));
  const rows = await getRows('/v1/purchase-orders?limit=100');
  assert.match(String(rows.failed), /Not allowed/);
  assert.match(pick('x', rows, 'id', () => '', 'Choose'), /role="alert"[^>]*>Not allowed/);
});
test('an unreachable list is said too', async () => {
  const { getRows } = load(async () => { throw new Error('down'); });
  assert.match(String((await getRows('/v1/purchase-orders?limit=100')).failed), /connect/);
});
