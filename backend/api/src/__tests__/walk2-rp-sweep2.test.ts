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
test('RP-26: QC review batch cards wrap their code and never fall back to the uuid', () => {
  const js = readFileSync(join(root, 'web/ws-floord.js'), 'utf8');
  assert.match(js, /width:100%;min-width:0;overflow-wrap:anywhere;cursor:pointer/);
  assert.doesNotMatch(js, /r\.batchNumber \|\| r\.oilBatchId/);
});
test('RP-27: decided suggestions read Approved/Dismissed, not the wire word', () => {
  assert.match(readFileSync(join(root, 'web/ws-floord.js'), 'utf8'), /\{ APPROVED: 'Approved', DISMISSED: 'Dismissed' \}\)\[x\.status\]/);
});
test('RP-28: an unreachable server is a failure on the floor stations, not an empty queue', async () => {
  const js = readFileSync(join(root, 'web/ws-floor.js'), 'utf8');
  const s = js.indexOf('  async function call('), e = js.indexOf('\n  }\n', s) + 4;
  const ctx: Record<string, unknown> = { tunnel: async () => { throw new Error('down'); } }; vm.createContext(ctx);
  vm.runInContext(js.slice(s, e) + '\nthis.f = call;', ctx);
  const r = await (ctx.f as (p: string) => Promise<{ status: number }>)('/v1/floor/queue');
  assert.ok(r.status >= 400);
});
test('RP-28: Stock cover and QC review treat an unreachable server as a failure too', () => {
  assert.doesNotMatch(readFileSync(join(root, 'web/ws-floord.js'), 'utf8'), /catch \(e\) \{ return \{ status: 0,/);
});
test('RP-29: the offline banner never rewrites itself in a loop', () => {
  const js = readFileSync(join(root, 'web/ws-floor-ops.js'), 'utf8');
  assert.match(js, /if \(b\.textContent !== msg\) b\.textContent = msg;/);
  assert.match(js, /t\.id === 'fo-net' \|\| \(t\.closest && t\.closest\('#fo-net'\)\)/);
});
test('RP-26: the QC review decision chip wraps at narrow widths', () => {
  assert.match(readFileSync(join(root, 'web/ws-floord.js'), 'utf8'), /white-space:normal;height:auto;max-width:100%;text-align:left" class="chip/);
});
test('RP-30: the reason on a disabled Edit says the status in words', () => {
  const js = readFileSync(join(root, 'web/shell.js'), 'utf8');
  assert.doesNotMatch(js, /Only a DRAFT purchase/);
  assert.match(js, /Only a draft purchase order can be edited; this one is ' \+ String\(statusWord\(r\.status\)\)\.toLowerCase\(\)/);
});
test('RP-31: status words keep acronyms (QC, COA, MSDS) and the floor pickers use them', () => {
  const ctx: { window: Record<string, any> } = { window: {} }; vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'web/screen-guide.js'), 'utf8'), ctx);
  const w = ctx.window.RaGuide.statusWord as (v: string) => string;
  assert.equal(w('COA'), 'COA'); assert.equal(w('MSDS'), 'MSDS'); assert.equal(w('AWAITING_QC_SIGNOFF'), 'Awaiting QC signoff');
  assert.match(readFileSync(join(root, 'web/ws-floorb.js'), 'utf8'), /function word\(v\) \{ if \(window\.RaGuide && RaGuide\.statusWord\) return RaGuide\.statusWord\(v\);/);
});
test('RP-34: Vault and Platform never show the browser\'s "Failed to fetch"', () => {
  for (const f of ['web-vault/vault.js', 'web-platform/platform.js']) {
    const js = readFileSync(join(root, f), 'utf8');
    assert.match(js, /catch \(netErr\) \{ aesKey = null; handshakePromise = null; throw new (Vault|Platform)Error\('NETWORK'/, f);
    assert.match(js, /try \{ await handshake\(\); \} catch \(e\)/, f);
  }
});
test('RP-35: dates and counts use the Indian format, not the browser default', () => {
  for (const f of ['web/shell.js', 'web/ruh.js', 'web/ws-produce.js', 'web/ws-setup.js', 'web-vault/vault.js', 'web-platform/platform.js', 'web-vault/ruh.js', 'web-platform/ruh.js']) {
    assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), /\.toLocaleString\(\)/, f);
  }
});
