/**
 * SWEEP-FACTORY: header alert bell (web/shell.js; no browser). loadAlerts polls /v1/alerts every 30 s
 * and dropped any failure (`if (!d) return;` and `.catch(function () {})`): the badge kept its last
 * count, or none, and "No alerts" stayed in the panel while the alert feed was down, so an overdue
 * QC or stock alert read as cleared. A failure now marks the badge and says so in the panel, once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/shell.js'), 'utf8');

function run(res: unknown) {
  const s = js.indexOf('  function loadAlerts(');
  const el = () => ({ textContent: '', innerHTML: '', title: '', style: { display: 'none' }, querySelectorAll: () => [] });
  const els: Record<string, ReturnType<typeof el>> = { 'ra-bell-badge': el(), 'ra-bell-pop': el() };
  const toasts: string[] = [];
  const ctx: Record<string, unknown> = {
    $: (id: string) => els[id] || null, escHtml: (x: string) => String(x), toast: (m: string) => toasts.push(m), alertNavKey: () => null,
    tunnel: () => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)), window: {},
  };
  vm.createContext(ctx);
  // loadAlerts and the helper right after it
  const end = js.indexOf('\n  }\n', js.indexOf('function alertsFailed(', s)) + 4;
  vm.runInContext(js.slice(s, end) + '\nthis.f = loadAlerts;', ctx);
  return { go: async () => { (ctx.f as () => void)(); await new Promise((r) => setTimeout(r, 5)); }, els, toasts };
}

for (const [name, res] of [['refused', { status: 500, json: { error: { message: 'down' } } }], ['unreachable', new Error('channel')]] as const) {
  test(`a ${name} alert feed is shown on the bell, not left as the last count`, async () => {
    const r = run(res); await r.go();
    assert.equal(r.els['ra-bell-badge']!.textContent, '!');
    assert.equal(r.els['ra-bell-badge']!.style.display, 'inline');
    assert.match(r.els['ra-bell-pop']!.innerHTML, /did not load/);
    assert.equal(r.toasts.length, 1);
  });
}

test('form pickers do not swallow a failure either', () => {
  assert.equal((js.match(/fkRows\(f\.fk\)\.then[\s\S]{0,900}?\.catch\(function \(\) \{ fkFail\(sel, /g) || []).length, 2);
});
