/**
 * The quick-access dock, all three RawProd consoles (owner 2026-09-29: "dock is abnormally huge, it
 * won't be responsive" — 37 Factory destinations in one pill, several sharing one glyph).
 *
 * Static, like console-focus-mode.test.ts: web/dock.js (the pure model) and the Factory's own
 * shell.js + ws-*.js run in a `vm` context with a small fake window/document — the scripts share one
 * global scope in the browser, so ROLES, DOCK_DEFAULTS, dockKeys() and dockInnerHtml() are reachable
 * exactly as the page sees them. Platform/Vault NAV and ICONS are read from their sources. The
 * layout at 1800/1024/390 px was checked in a real headless browser for this lane.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Values from a vm context carry that realm's prototypes; compare them as plain data. */
const J = (v: unknown) => JSON.parse(JSON.stringify(v));

/* eslint-disable @typescript-eslint/no-explicit-any */
function dockModel(): any {
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(read('web/dock.js'), ctx);
  return ctx.RaDock;
}
function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), m };
}

/** The Factory console as the browser loads it (index.html order), minus boot (readyState 'loading'). */
function factory(): any {
  const noop = () => {};
  const el = (): any => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, setAttribute: noop, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
  const store = memStore();
  const ctx: any = {
    console, setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    document: { readyState: 'loading', addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: el, head: el(), body: el(), documentElement: el() },
    navigator: { onLine: true }, location: { hash: '', pathname: '/', search: '', href: 'https://rawfactory.example/' }, history: { replaceState: noop },
    localStorage: store, addEventListener: noop, innerWidth: 1800, innerHeight: 1000,
    matchMedia: () => ({ matches: false, addEventListener: noop }), TextEncoder, TextDecoder, atob, btoa, URL,
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  const html = read('web/index.html');
  const scripts = [...html.matchAll(/<script src="\/([\w-]+\.js)"/g)].map((m) => m[1] ?? '')
    .filter((f) => ['dock.js', 'shell.js', 'ws-supply.js', 'ws-mfg.js', 'ws-platform.js', 'ws-produce.js'].includes(f));
  assert.deepEqual(scripts, ['dock.js', 'shell.js', 'ws-supply.js', 'ws-mfg.js', 'ws-platform.js', 'ws-produce.js']);
  for (const f of scripts) vm.runInContext(read(`web/${f}`), ctx, { filename: f });
  ctx.__store = store;
  return ctx;
}
const run = (ctx: any, code: string) => vm.runInContext(code, ctx);

// ── the model ────────────────────────────────────────────────────────────────────────────────────────────────────

test('RaDock.pick: role defaults, capped at 8, only sections the session holds, pins win', () => {
  const D = dockModel();
  assert.equal(D.MAX, 8);
  assert.ok(D.PHONE <= 5);
  const keys = Array.from({ length: 37 }, (_, i) => 'k' + i);
  assert.deepEqual(J(D.pick(keys, ['k3', 'k1', 'nope', 'k3'], null)), ['k3', 'k1', 'k0'], 'unknown/duplicate defaults skipped, gap filled in role order');
  const many = D.pick(keys, keys, null);
  assert.equal(many.length, 8, 'never more than 8');
  assert.deepEqual(J(D.pick(keys, ['k1'], ['k9', 'k2'])), ['k9', 'k2'], 'pins replace the defaults');
  assert.deepEqual(J(D.pick(keys, ['k1'], ['gone'])), ['k1'], 'pins that resolve to nothing fall back to defaults');
  assert.equal(D.pick(keys, null, keys).length, 8, 'pins are capped too');
  assert.deepEqual(J(D.pick(['a', 'b'], ['a', 'b', 'c', 'd'], null)), ['a', 'b']);
});

test('RaDock pins: per person, stored as JSON, capped, tolerant of junk; a full dock refuses a pin', () => {
  const D = dockModel();
  const s = memStore();
  const k1 = D.storageKey('factory', 'qc', 'u1'), k2 = D.storageKey('factory', 'qc', 'u2');
  assert.notEqual(k1, k2);
  assert.equal(D.loadPins(s, k1), null);
  D.savePins(s, k1, ['a', 'b']);
  assert.deepEqual(J(D.loadPins(s, k1)), ['a', 'b']);
  assert.equal(D.loadPins(s, k2), null, 'another person on the same browser keeps the defaults');
  s.setItem(k2, '{not json'); assert.equal(D.loadPins(s, k2), null);
  s.setItem(k2, JSON.stringify(['x', 3, '', 'y'])); assert.deepEqual(J(D.loadPins(s, k2)), ['x', 'y']);
  D.savePins(s, k1, null); assert.equal(D.loadPins(s, k1), null);
  const full = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.deepEqual(J(D.togglePin(full, 'z')), { pins: full, pinned: false, full: true });
  assert.deepEqual(J(D.togglePin(full, 'c').pins), ['a', 'b', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(J(D.togglePin(['a'], 'b')), { pins: ['a', 'b'], pinned: true, full: false });
  // Blocked storage never throws.
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(D.loadPins(bad, k1), null);
  D.savePins(bad, k1, ['a']);
});

test('RaDock.GLYPHS: every glyph is its own artwork', () => {
  const D = dockModel();
  assert.deepEqual(J(D.duplicates(Object.entries(D.GLYPHS))), []);
  assert.deepEqual(J(D.duplicates([['a', 'M1 1'], ['b', 'M1  1'], ['c', 'M2 2']])), [['a', 'b']]);
});

test('every console ships the same dock.js, loads it before its console script, and caches it offline', () => {
  const master = read('web/dock.js');
  for (const [dir, script] of [['web', 'shell.js'], ['web-platform', 'platform.js'], ['web-vault', 'vault.js']]) {
    assert.equal(read(`${dir}/dock.js`), master, `${dir}/dock.js differs from web/dock.js`);
    const html = read(`${dir}/index.html`);
    const at = html.indexOf('<script src="/dock.js"></script>');
    assert.ok(at > 0 && at < html.indexOf(`<script src="/${script}"`), `${dir}: dock.js must load before ${script}`);
  }
  assert.match(read('web/sw.js'), /'\/dock\.js'/);
  assert.match(read('web-platform/sw.js'), /'\/dock\.js'/);
  // The dock CSS block is the same in all three consoles, runway token included.
  const block = (css: string) => css.slice(css.indexOf('/* ---------------- quick-access dock (web/dock.js)'));
  const shellCss = block(read('web/ui-contract/shell.css'));
  assert.match(shellCss, /--dock-runway/);
  assert.match(shellCss, /env\(safe-area-inset-bottom/);
  assert.equal(block(read('web-platform/platform.css')), shellCss);
  assert.equal(block(read('web-vault/vault.css')), shellCss);
});

// ── Factory ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('Factory: every role has ≤ 8 dock defaults it actually holds, and every section its own glyph', () => {
  const ctx = factory();
  const roles: string[] = Object.keys(run(ctx, 'ROLES'));
  assert.ok(roles.length >= 11);
  for (const r of roles) {
    const nav: [string, string, string, string][] = run(ctx, `ROLES[${JSON.stringify(r)}].nav`);
    const defaults: string[] = run(ctx, `DOCK_DEFAULTS[${JSON.stringify(r)}]`);
    assert.ok(Array.isArray(defaults) && defaults.length >= 4 && defaults.length <= 8, `${r}: 4–8 defaults`);
    for (const k of defaults) assert.ok(nav.some((n) => n[0] === k), `${r}: default "${k}" is not one of its sections`);
    assert.equal(defaults[0], 'dashboard', `${r}: the dock starts at the dashboard`);
    const icons: Record<string, string> = run(ctx, 'ICONS');
    for (const n of nav) assert.ok(icons[n[2]], `${r}/${n[0]}: glyph "${n[2]}" is not defined (it would fall back to the grid)`);
    const dupes = J(run(ctx, 'RaDock').duplicates(nav.map((n) => [n[1], icons[n[2]]])));
    assert.deepEqual(dupes, [], `${r}: sections sharing one glyph`);
  }
  // The owner's own view: the eight he named, in order.
  assert.deepEqual(J(run(ctx, 'DOCK_DEFAULTS.superadmin')), ['dashboard', 'plans', 'runs', 'coa', 'shelftasks', 'shelfdisplay', 'sorders', 'notifs']);
});

test('Factory: the rendered dock — ≤ 8 labelled destinations, All sections, Ask Aria; pins persist per person', () => {
  const ctx = factory();
  for (const r of Object.keys(run(ctx, 'ROLES'))) {
    run(ctx, `st.role = ${JSON.stringify(r)}; st.nav = 'dashboard'; session = { user: { id: 'u1' }, perms: [] };`);
    const html: string = run(ctx, 'dockInnerHtml()');
    const items = [...html.matchAll(/<button type="button" data-nav="([^"]+)" data-dock="[^"]+" class="qb([^"]*)" aria-label="([^"]+)"[^>]*>(<svg[\s\S]*?<\/svg>)/g)];
    assert.ok(items.length >= 4 && items.length <= 8, `${r}: ${items.length} dock destinations`);
    assert.equal(new Set(items.map((m) => m[4])).size, items.length, `${r}: repeated glyph in the dock`);
    assert.ok(items.every((m) => (m[3] ?? '').length > 0), 'every destination has an aria-label');
    assert.ok(items.filter((m) => / hot/.test(m[2] ?? '')).length <= 4, 'the phone tab bar keeps ≤ 4 destinations');
    assert.match(html, /id="ra-dock-toggle" class="qb dk-navtoggle hot" aria-label="All sections"/);
    assert.match(html, /<span class="kb-d">All sections<\/span><span class="kb-m">More<\/span>/);
    assert.match(html, /id="ra-aria-dock" aria-label="Ask Aria">[\s\S]*⌘K/);
    assert.equal((html.match(/class="qb/g) || []).length, items.length + 2, 'nothing else in the dock');
  }
  // Pin from the sections sheet: saved for this person only, capped at 8.
  run(ctx, `st.role = 'superadmin'; session = { user: { id: 'u1' }, perms: [] };`);
  assert.equal(run(ctx, 'dockKeys()').length, 8);
  run(ctx, `togglePin('notifs')`); // unpin
  assert.deepEqual(J(run(ctx, 'dockKeys()')), ['dashboard', 'plans', 'runs', 'coa', 'shelftasks', 'shelfdisplay', 'sorders']);
  run(ctx, `togglePin('trace')`);
  assert.equal(run(ctx, 'dockKeys()').slice(-1)[0], 'trace');
  run(ctx, `togglePin('users')`); // full: refused (toast only)
  assert.equal(run(ctx, 'dockKeys()').length, 8);
  assert.ok(!run(ctx, 'dockKeys()').includes('users'));
  assert.match(run(ctx, `railNavHtml(ROLES.superadmin)`), /data-pin="trace" aria-pressed="true"/);
  assert.match(run(ctx, `railNavHtml(ROLES.superadmin)`), /id="ra-dock-reset"/);
  run(ctx, `session = { user: { id: 'u2' }, perms: [] };`);
  assert.ok(!run(ctx, 'dockKeys()').includes('trace'), 'another person keeps the role defaults');
});

// ── Platform + Vault ─────────────────────────────────────────────────────────────────────────────────────────────

function consoleNav(file: string): { nav: { id: string; label: string; icon: string }[]; icons: Record<string, string> } {
  const src = read(file);
  const navSrc = src.slice(src.indexOf('var NAV = ['), src.indexOf('];', src.indexOf('var NAV = [')) + 2).replace('var NAV =', '');
  const icoStart = src.indexOf('var ICONS = {');
  const icoSrc = src.slice(icoStart, src.indexOf('};', icoStart) + 2).replace('var ICONS =', '');
  // The console's own names win over the shared set, as at runtime.
  const icons = { ...dockModel().GLYPHS, ...vm.runInNewContext('(' + icoSrc.replace(/;\s*$/, '') + ')') };
  return { nav: vm.runInNewContext('(' + navSrc.replace(/;\s*$/, '') + ')'), icons };
}

test('Platform + Vault: every section its own defined glyph; the dock is capped and says All sections / More', () => {
  const D = dockModel();
  for (const file of ['web-platform/platform.js', 'web-vault/vault.js']) {
    const { nav, icons } = consoleNav(file);
    for (const n of nav) assert.ok(icons[n.icon], `${file} ${n.id}: glyph "${n.icon}" undefined`);
    assert.deepEqual(J(D.duplicates(nav.map((n) => [n.label, icons[n.icon]]))), [], `${file}: sections sharing one glyph`);
    const src = read(file);
    assert.match(src, /RaDock\.pick\(/);
    assert.match(src, /h\('span', \{ class: 'kb-d' \}, \['All sections'\]\), h\('span', \{ class: 'kb-m' \}, \['More'\]\)/);
    assert.match(src, /\(i < RaDock\.PHONE \? ' hot' : ''\)/);
    assert.ok(!/visible\.map\(function \(n, i\) \{\s*var on = n\.id === activeView;\s*return h\('button', \{ type: 'button', class: 'qb'/.test(src), `${file}: the dock still lists every section`);
  }
  const p = read('web-platform/platform.js');
  const defaults = vm.runInNewContext(p.slice(p.indexOf('var DOCK_DEFAULTS = ') + 20, p.indexOf(';', p.indexOf('var DOCK_DEFAULTS = '))));
  assert.ok(defaults.length <= 8);
  assert.ok(!defaults.includes('tutorial'), 'Tutorials stays in the sections sheet');
});
