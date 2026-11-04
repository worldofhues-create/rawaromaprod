/**
 * WALK-RP-16 [QC]: Record batch COA's spec line (showSpec in web/ws-mfg.js) said nothing when the
 * product's QC spec read was refused or failed (`if (!s) return;` and `.catch(function () {})`), so
 * QC entered readings with no limits shown and no word that they had failed to load.
 * WALK-RP-17 [AUTH, UI only]: after sign-in the Factory read /me with `.catch(function () {})` and
 * then pruned the rail by the (now empty) permissions, so a failed /me left a console with almost no
 * screens and no buttons and nothing saying why. A failed /me now keeps the rail and says so; the
 * server still checks every call.
 * Comments are stripped before matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('WALK-RP-16: a failed QC spec read is said on the COA form', async () => {
  const js = readFileSync(join(root, 'web/ws-mfg.js'), 'utf8');
  const s = js.indexOf('    function showSpec('), e = js.indexOf('\n    }\n', s) + 6;
  for (const res of [{ status: 500, json: { error: { message: 'down' } } }, new Error('x')]) {
    const els: Record<string, { value?: string; textContent: string }> = { 'ra-cp': { value: 'P1', textContent: '' }, 'ra-cspec': { textContent: '' } };
    const ctx: Record<string, unknown> = { $: (id: string) => els[id], tunnel: () => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)) };
    vm.createContext(ctx);
    vm.runInContext(js.slice(s, e) + '\nthis.f = showSpec;', ctx);
    (ctx.f as () => void)();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(els['ra-cspec']!.textContent, /did not load/);
  }
});

test('WALK-RP-17: a failed /me is said, and does not prune the rail to nothing', () => {
  const js = strip(readFileSync(join(root, 'web/shell.js'), 'utf8'));
  const i = js.indexOf("tunnel('/me').then(function (m)");
  const stmt = js.slice(i, js.indexOf('\n', i));
  assert.doesNotMatch(stmt, /\.catch\(function \(\) \{\}\)/);
  assert.match(stmt, /toast\(/);
});

test('WALK-RP-16: the COA product list reads every spec page and says a refusal', () => {
  const js = strip(readFileSync(join(root, 'web/ws-mfg.js'), 'utf8'));
  const s = js.indexOf('    function loadProducts('), body = js.slice(s, js.indexOf('\n    }\n', s));
  assert.match(body, /fkRows\('\/v1\/product-qc-specs'\)/);
  assert.match(body, /rs\[0\]\.status >= 400 \|\| rs\[1\]\.error/);
});
