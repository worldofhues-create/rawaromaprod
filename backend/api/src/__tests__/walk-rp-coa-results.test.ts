/**
 * WALK-RP-13 (QC): a QC inspection's printed certificate (printDoc in web/shell.js) took its TEST
 * RESULTS from the newest 100 result rows of the whole quality table, and printed with no results
 * section at all when that read failed. Once 100 newer results existed, an older lot's certificate
 * printed with its readings missing and nothing on the page saying so: a certificate that looks
 * complete and is not. It now reads every page, and a failed read prints a warning instead of
 * silence (fail closed).
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
const s = js.indexOf('  function printDoc('), e = js.indexOf('\n  }\n', s) + 4;

function print(pages: Array<{ status: number; json?: unknown } | Error>) {
  let i = 0, written = '';
  const w = { document: { write: (h: string) => { written += h; }, close() {} } };
  const ctx: Record<string, unknown> = {
    tunnel: async () => { const p = pages[Math.min(i++, pages.length - 1)]!; if (p instanceof Error) throw p; return p; },
    window: { open: () => w }, toast() {}, PRINTABLE: {}, HIDE: {}, sensitive: () => false, isUuid: () => false, isStamp: () => false,
    fmtStamp: (_k: string, v: unknown) => v, label: (k: string) => k, escHtml: (x: string) => String(x),
  };
  vm.createContext(ctx);
  vm.runInContext(js.slice(fkS, fkE) + js.slice(s, e) + '\nthis.f = printDoc;', ctx);
  (ctx.f as (ep: string, r: unknown) => void)('/v1/qc-inspections', { qcInspectionId: 'OLD', batchNo: 'B1' });
  return new Promise<string>((r) => setTimeout(() => r(written), 20));
}

test('an older inspection still prints its readings when 100 newer results exist', async () => {
  const newer = Array.from({ length: 100 }, (_, k) => ({ qcInspectionId: 'N' + k, parameterName: 'X', observedValue: 1 }));
  const html = await print([{ status: 200, json: { data: newer, meta: { cursor: 'c' } } },
    { status: 200, json: { data: [{ qcInspectionId: 'OLD', parameterName: 'Refractive index', observedValue: 1.47, result: 'PASS' }], meta: {} } }]);
  assert.match(html, /TEST RESULTS[\s\S]*Refractive index/);
});

for (const [name, p] of [['refused', { status: 500, json: { error: { message: 'down' } } }], ['unreachable', new Error('x')]] as const) {
  test(`a ${name} results read prints a warning, never a silent certificate`, async () => {
    const html = await print([p]);
    assert.match(html, /TEST RESULTS[\s\S]*could not be loaded/i);
  });
}
