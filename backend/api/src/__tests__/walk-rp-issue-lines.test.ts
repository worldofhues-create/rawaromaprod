/**
 * WALK-RP-14 (stock): Issue materials (openIssue in web/ws-produce.js) found a pick list's lines among
 * the newest 100 pick-list lines of the whole table. Once 100 newer lines existed, an older pick list
 * answered "This pick list has no lines." and its materials could not be issued, so the run waited or
 * stock left the shelf with no issue recorded. It now reads every page before filtering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shell = readFileSync(join(root, 'web/shell.js'), 'utf8');
const fkS = shell.indexOf('  async function fkRows('), fkE = shell.indexOf('\n  }\n', fkS) + 4;
const js = readFileSync(join(root, 'web/ws-produce.js'), 'utf8');
const s = js.indexOf('  function openIssue('), e = js.indexOf('\n  }\n', s) + 4;

test('an older pick list finds its lines when 100 newer lines exist', async () => {
  const newer = Array.from({ length: 100 }, (_, k) => ({ materialPickListId: 'N' + k, materialPickListItemId: 'i' + k }));
  const toasts: string[] = []; let sheet = '';
  const ctx: Record<string, unknown> = {
    tunnel: async (p: string) => p.includes('/lots') ? { status: 200, json: { data: [] } }
      : p.includes('cursor=') ? { status: 200, json: { data: [{ materialPickListId: 'OLD', materialPickListItemId: 'x', pickedQty: 2 }], meta: {} } }
      : { status: 200, json: { data: newer, meta: { cursor: 'c' } } },
    toast: (m: string) => toasts.push(m), err: (_r: unknown, f: string) => f, data: (r: { json: { data: unknown } }) => r.json.data,
    escHtml: (x: string) => String(x), lbl: (x: string) => x, num: (x: number) => String(x),
    openSheet: (o: { body: string }) => { sheet = o.body; return { sheet: {}, close() {} }; },
  };
  vm.createContext(ctx);
  vm.runInContext(shell.slice(fkS, fkE) + js.slice(s, e) + '\nthis.f = openIssue;', ctx);
  (ctx.f as (r: unknown) => void)({ materialPickListId: 'OLD' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(toasts, []);
  assert.match(sheet, /data-line="x"/);
});
