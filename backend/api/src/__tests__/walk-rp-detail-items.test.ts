/**
 * WALK-RP-12: a purchase order's, quotation's, sales order's or GRN's Line items (the row detail in
 * web/shell.js) read the newest 100 lines of the WHOLE item table and kept the ones for this record.
 * Once a hundred newer lines existed, every older PO opened as "No line items recorded." — a buyer or
 * store keeper read a PO as empty — and a refused read (403/500) said the same. It now reads every
 * page and filters, and a refused read says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/shell.js'), 'utf8');
const fkS = js.indexOf('  async function fkRows('), fkE = js.indexOf('\n  }\n', fkS) + 4;
const s = js.indexOf('  function loadRowDetailItems('), e = js.indexOf('\n  }\n', s) + 4;

function run(pages: Array<{ status: number; json: unknown }>) {
  let i = 0;
  const box = { parentNode: {}, textContent: '', innerHTML: '' };
  const ctx: Record<string, unknown> = { tunnel: async () => pages[Math.min(i++, pages.length - 1)], label: (c: string) => c, fmt: (_c: string, v: unknown) => String(v) };
  vm.createContext(ctx);
  vm.runInContext(js.slice(fkS, fkE) + js.slice(s, e) + '\nthis.f = loadRowDetailItems;', ctx);
  (ctx.f as (c: unknown, id: string, b: unknown) => void)({ items: { ep: '/v1/purchase-order-items', fk: 'poId', cols: ['qty'] } }, 'OLD', box);
  return new Promise<typeof box>((r) => setTimeout(() => r(box), 20));
}

test('an older PO still shows its lines when 100 newer lines exist', async () => {
  const newer = Array.from({ length: 100 }, (_, k) => ({ poId: 'NEW' + k, qty: 1 }));
  const box = await run([{ status: 200, json: { data: newer, meta: { cursor: 'c2' } } }, { status: 200, json: { data: [{ poId: 'OLD', qty: 7 }], meta: {} } }]);
  assert.match(box.innerHTML, /<td>7<\/td>/);
});

test('a refused read is said, not "No line items recorded."', async () => {
  const box = await run([{ status: 403, json: { error: { message: 'Not your role.' } } }]);
  assert.doesNotMatch(box.textContent, /No line items recorded/);
  assert.match(box.textContent, /did not load|Not your role/);
});
