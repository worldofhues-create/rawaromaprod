/**
 * Static screen checks for the Factory, Platform and Vault consoles (lane ux-audit, owner 2026-10-09:
 * "all features are easily understandable and no training would be required").
 *
 *   - no developer text on screen (no snake_case, endpoint paths, file names, lanes or tickets in the
 *     words the screen guide shows; no "this build"; no bare status codes in error messages);
 *   - no browser prompt()/confirm()/alert() — every question is an in-page sheet that says what happens;
 *   - every screen has a visible title and a line saying what it is for; toasts are announced;
 *   - the one primary action on a list says what it makes ("+ New purchase order").
 * The consoles were also driven headless at 1440 and 390 px (docs/ui/evidence/ux-audit/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The script with comments removed: what can reach a screen is in code, not in its commentary. */
function code(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
const CONSOLE_SCRIPTS = [
  ...readdirSync(join(ROOT, 'web')).filter((f) => /^(shell|routes|screen-guide|tutorial|ws-[\w-]+)\.js$/.test(f)).map((f) => `web/${f}`),
  'web-platform/platform.js', 'web-vault/vault.js',
];

/* eslint-disable @typescript-eslint/no-explicit-any */
function guide(): any {
  const ctx: any = {};
  vm.createContext(ctx);
  vm.runInContext(read('web/screen-guide.js'), ctx);
  return ctx.RaGuide;
}

test('no browser prompt(), confirm() or alert() in any console: every question is an in-page sheet', () => {
  assert.ok(CONSOLE_SCRIPTS.length >= 11, CONSOLE_SCRIPTS.join(', '));
  for (const f of CONSOLE_SCRIPTS) {
    const js = code(read(f));
    assert.doesNotMatch(js, /window\.(prompt|confirm|alert)\s*\(/, `${f} still asks through the browser`);
    assert.doesNotMatch(js, /(^|[^.\w])(prompt|confirm|alert)\s*\(\s*'/m, `${f} still asks through the browser`);
  }
});

test('error messages never show a bare status code or "this build"', () => {
  for (const f of CONSOLE_SCRIPTS) {
    const js = code(read(f));
    assert.doesNotMatch(js, /\(' \+ \w+\.status \+ '\)'/, `${f}: a "(403)"-style message`);
    assert.doesNotMatch(js, /Request failed \(/, `${f}: "Request failed (…)"`);
    assert.doesNotMatch(js, /this build/i, `${f}: "this build"`);
    assert.doesNotMatch(js, /toast\('Done'/, `${f}: a bare "Done"`);
  }
});

test('the words the screen guide shows are plain: no snake_case, paths, file, lane or ticket names', () => {
  const G = guide();
  const shown: string[] = [];
  for (const table of [G.LABEL, G.HELP, G.COMES_FROM, G.COLUMN, G.ACTION_HELP, G.DONE, G.STATUS_WORD]) shown.push(...Object.values<string>(table));
  for (const r of Object.values<any>(G.ROLE_LABEL)) shown.push(...Object.values<string>(r));
  shown.push(...G.GROUPS);
  assert.ok(shown.length > 300, `${shown.length} strings`);
  const leaks = shown.filter((s) => /\b[a-z]+_[a-z_]+\b/.test(s) || /\/v1\//.test(s) || /\.(ts|js|sql|md)\b/.test(s)
    || /\b(RP-[A-Z0-9]+|PB-\d+|lane\b|TODO|FIXME|endpoint|payload|uuid|null|undefined)\b/i.test(s) || /[A-Z]{2,}_[A-Z]/.test(s));
  assert.deepEqual(leaks, []);
  for (const s of shown) assert.equal(s.trim(), s, `stray spaces: "${s}"`);
});

test('Factory: every screen has a visible title, a trail back, a help line, and the tab title follows', () => {
  const shell = read('web/shell.js');
  assert.match(shell, /\$\('ra-title'\)\.textContent = item\[1\];\s*document\.title = item\[1\] \+ ' · ' \+ R\.label \+ ' · Factory';\s*paintIntro\(item\);/);
  assert.match(shell, /'<div class="content"><div class="screen-intro" id="ra-intro"><\/div><section class="pageview" id="ra-view"><\/section><\/div>'/);
  assert.match(shell, /el\.innerHTML = '<nav class="crumbs" aria-label="You are here"><ol>' \+ trail \+ '<\/ol><\/nav>' \+ \(help \? '<p class="screen-help">'/);
});

test('Factory: empty lists say what to do next; the primary action names what it makes; no dead-end error cards', () => {
  const shell = read('web/shell.js');
  assert.ok(!shell.includes('<h3>No records yet</h3>'), 'the bare "No records yet" is gone');
  assert.match(shell, /var newLabel = cdef \? '\+ ' \+ String\(cdef\.title \|\| 'New record'\)\.replace/);
  assert.match(shell, /<h3>Nothing in ' \+ escHtml\(item\[1\]\) \+ ' yet<\/h3>/);
  assert.match(shell, /<button type="button" class="btn sm" data-ra-home>Go to your home screen<\/button>/, 'every error card has a way on');
  assert.match(shell, /var NO_ACCESS = 'Your role does not include this screen\. If you need it, ask your admin to add it to your role\.';/);
});

test('Factory: a step that changes a batch or a document is confirmed in words; the result is said in words', () => {
  const shell = read('web/shell.js');
  assert.match(shell, /function needsConfirm\(a\) \{ return a\.tone === 'bad' \|\| a\.tone === 'warn' \|\| a\.tone === 'good' \|\| a\.confirm === true; \}/);
  assert.match(shell, /toast\(\(window\.RaGuide && RaGuide\.DONE\[a\.label\]\) \|\| \(a\.label \+ ': done'\), 'good'\)/);
  assert.match(shell, /var help = window\.RaGuide && RaGuide\.ACTION_HELP\[String\(label\)\];/, 'each row button says what it does');
  const G = guide();
  const c = code(shell);
  const actions = c.slice(c.indexOf('var ACTIONS = {'), c.indexOf('var DETAIL = {'));
  const actionLabels = [...actions.matchAll(/\{ label: '([^']+)'/g)].map((m) => m[1] ?? '');
  assert.ok(actionLabels.length >= 30, `${actionLabels.length} row buttons`);
  for (const l of new Set(actionLabels)) assert.ok(G.ACTION_HELP[l], `row button "${l}" has no explanation`);
});

test('toasts are announced to screen readers in all three consoles', () => {
  assert.match(read('web/shell.js'), /t\.setAttribute\('role', tone === 'bad' \? 'alert' : 'status'\); t\.setAttribute\('aria-live'/);
  for (const f of ['web-platform/platform.js', 'web-vault/vault.js']) assert.match(read(f), /class: 'toast' \+ \(bad \? ' bad' : ''\), role: bad \? 'alert' : 'status', 'aria-live'/, f);
});

test('Platform and Vault: a title per screen in the tab, a help line, and plain words on the sign-in card', () => {
  for (const f of ['web-platform/platform.js', 'web-vault/vault.js']) {
    const js = read(f);
    assert.match(js, /document\.title = label \+ ' · (Platform|Vault) · Raw Aroma Chem';/, f);
    assert.match(js, /var HELP = \{/, f);
    assert.match(js, /Sign-in is not switched on here yet\. Ask your administrator\./, f);
  }
  const p = code(read('web-platform/platform.js'));
  assert.ok(!p.includes("['Internal']"), 'the unexplained "Internal" chip');
  assert.ok(!/'Git SHA'/.test(p) && !/'Outbox'/.test(p) && !/'Inbound parked'/.test(p), 'Platform tiles speak plainly');
  assert.match(p, /h\('details', \{ style: 'margin:0 0 12px' \}, \[h\('summary'[^\]]+\['For the person installing a hardware controller'\]\)/, 'the controller protocol is tucked away for the installer');
  const v = code(read('web-vault/vault.js'));
  assert.match(v, /function rowLink\(tr, hash, label\) \{/);
  assert.ok((v.match(/rowLink\(h\('tr'/g) || []).length >= 2, 'formula and version rows open from the keyboard');
  assert.ok(!/\[status \|\| 'UNKNOWN'\]/.test(v), 'Vault status chips say words');
});
