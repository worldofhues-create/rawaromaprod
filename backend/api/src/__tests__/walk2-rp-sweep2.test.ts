/** WALK2-RP-24: row actions 24px on touch. WALK2-RP-25: Stock cover printed the rule engine's JSON value. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
test('RP-24: row actions keep the touch floor', () => {
  const css = readFileSync(join(root, 'web/ui-contract/shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /@media \(pointer:coarse\)\{ \.ra-act\{min-height:var\(--ch-touch-floor-coarse-pointer\)\} \}/);
});
test('RP-25: the stock-cover rule line says its value in words', () => {
  const js = readFileSync(join(root, 'web/ws-floord.js'), 'utf8');
  const s = js.indexOf('    function sayVal('), e = js.indexOf('    var rows = d.items.map(');
  const ctx: Record<string, unknown> = {}; vm.createContext(ctx); vm.runInContext(js.slice(s, e) + '\nthis.f = ruleWords;', ctx);
  const f = ctx.f as (x: string) => string;
  assert.equal(f('Rule 1: sku = X-50 → {"mode":"dynamic","defaultLeadDays":21}'), 'Rule 1: sku = X-50 → mode: dynamic, default lead days: 21');
  assert.equal(f('No rule matched → otherwise {"mode":"fixed"}'), 'No rule matched → otherwise mode: fixed');
  assert.match(js, /esc\(ruleWords\(it\.policy\.explain\)\)/);
});
