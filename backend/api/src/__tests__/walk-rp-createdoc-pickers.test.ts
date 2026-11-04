/**
 * WALK-RP-4: New purchase order, New sales order and New goods receipt (openCreateDoc in
 * web/shell.js) filled their Supplier, Material, Product SKU, PO and PO-line pickers from one
 * `?limit=100` page and `.catch(() => [])`. SWEEP-FACTORY-3 fixed the single-record forms only. With a
 * real material master the 101st material could not be put on a PO, and a failed list was an empty
 * dropdown that read as "there are none". Comments are stripped before matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const js = strip(readFileSync(join(root, 'web/shell.js'), 'utf8'));
const s = js.indexOf('  async function openCreateDoc(');
const body = js.slice(s, js.indexOf('\n  }\n', s));

test('document form pickers read every page through fkRows', () => {
  assert.doesNotMatch(body, /limit=100/);
  assert.match(body, /fkRows\(ep\)/);
});

test('a failed picker list is said on the form, not left empty', async () => {
  const pre = body.slice(0, body.indexOf('function opts('));
  const ctx: Record<string, unknown> = {
    CREATE_DOC: { '/x': { header: [{ n: 'v', fk: '/v1/vendors', fv: 'vendorId', fl: 'vendorName' }], item: [] } },
    fkRows: () => Promise.resolve({ rows: [], error: 'refused' }), guessId: () => null,
  };
  vm.createContext(ctx);
  vm.runInContext(pre + '\n return { fkCache: fkCache, fkErr: typeof fkErr === "undefined" ? null : fkErr }; }\nthis.f = openCreateDoc;', ctx);
  const r = await (ctx.f as (e: string) => Promise<{ fkErr: string | null }>)('/x');
  assert.equal(r.fkErr, 'refused');
});
