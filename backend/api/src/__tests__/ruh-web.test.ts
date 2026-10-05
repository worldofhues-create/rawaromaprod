/**
 * Always-on Ruh in Factory, Platform and Vault (static checks + ruh.js's pure parts in a `vm`; the
 * panel and RuhConfirm were also driven in a headless browser against a real API for this lane —
 * docs/ui/evidence/ruh/):
 *
 *   - one ruh.js, identical in all three consoles, loaded before the console script and cached
 *     offline (Factory + Platform; the Vault has no service worker), with the cache versions bumped;
 *   - the badge sits in the TOP BAR, never in the compact dock (≤ 8 entries per role stays true);
 *   - every console's tunnel routes a RUH_CONFIRM_REQUIRED answer through RuhConfirm and resends
 *     the same call with `ruhOverride`; cancelling returns a plain "not done";
 *   - the Vault asks the main box for its OWN notes only and never offers settings;
 *   - ruh.js calls no fetch() (the console's encrypted tunnel only) and shows no developer text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
/** The script with comments removed: what can reach a screen is in code, not in its commentary. */
function code(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
/* eslint-disable @typescript-eslint/no-explicit-any */
function ruhModel(): any {
  const ctx: any = { window: {}, document: { addEventListener() {}, removeEventListener() {} }, setTimeout, clearTimeout, setInterval, clearInterval, Promise };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('web/ruh.js'), ctx);
  return ctx.RaRuh;
}

test('one ruh.js in every console, loaded before the console script, cached offline, caches bumped', () => {
  const master = read('web/ruh.js');
  for (const [dir, script] of [['web', 'shell.js'], ['web-platform', 'platform.js'], ['web-vault', 'vault.js']] as const) {
    assert.equal(read(`${dir}/ruh.js`), master, `${dir}/ruh.js differs from web/ruh.js`);
    const html = read(`${dir}/index.html`);
    const at = html.indexOf('<script src="/ruh.js"></script>');
    assert.ok(at > html.indexOf('<script src="/sound.js"></script>') && at < html.indexOf(`<script src="/${script}"`), `${dir}: ruh.js after sound.js, before ${script}`);
  }
  assert.match(read('web/sw.js'), /const CACHE = 'ra-shell-v97'/);
  assert.match(read('web/sw.js'), /'\/ruh\.js'/);
  assert.match(read('web-platform/sw.js'), /const CACHE = 'platform-shell-v15'/);
  assert.match(read('web-platform/sw.js'), /'\/ruh\.js'/);
});

test('the badge is in the top bar of every console — never a dock entry', () => {
  const shell = read('web/shell.js');
  assert.match(shell, /'<span id="ra-ruh-slot"><\/span>' \+\s*'<button type="button" class="gbtn acc" id="ra-aria"/);
  assert.match(shell, /ruhSlot\.parentNode\.replaceChild\(RaRuh\.badge\('gbtn'\), ruhSlot\)/);
  assert.ok(!/RaRuh/.test(shell.slice(shell.indexOf('function dockInnerHtml'), shell.indexOf('function togglePin'))), 'not in the Factory dock');
  for (const f of ['web-platform/platform.js', 'web-vault/vault.js']) {
    const js = read(f);
    assert.match(js, /window\.RaRuh \? RaRuh\.badge\('gbtn'\) : null,\s*h\('button', \{ type: 'button', class: 'gbtn acc', 'aria-label': 'Ask Aria'/, `${f}: the badge sits beside Ask Aria`);
    const dock = js.slice(js.indexOf("var dock = h('div', { class: 'glass glass-deep qdock'"), js.indexOf("var handle = h('button'"));
    assert.ok(dock.length > 100 && !/RaRuh/.test(dock), `${f}: not in the dock`);
  }
});

test('every console routes a Ruh warning through RuhConfirm and resends with the reason', () => {
  assert.match(read('web/shell.js'), /if \(window\.RaRuh && RaRuh\.needsConfirm\(out\) && !opts\.ruhConfirmed\) return RaRuh\.guard\(out, opts, function \(o\) \{ return tunnel\(path, o\); \}\);/);
  assert.match(read('web-platform/platform.js'), /if \(window\.RaRuh && RaRuh\.needsConfirm\(out\) && !opts\.ruhConfirmed\) return RaRuh\.guard\(out, opts, function \(o\) \{ return tunnel\(path, o\); \}\);/);
  assert.match(read('web-vault/vault.js'), /if \(window\.RaRuh && RaRuh\.needsConfirm\(r\) && !\(opts && opts\.ruhConfirmed\)\) r = await RaRuh\.guard\(r, opts \|\| \{\}, function \(o\) \{ return tunnel\(path, o\); \}\);/);
});

test('RuhConfirm flow (pure): needsConfirm, the resend carries ruhOverride and the original body, cancel is "not done"', async () => {
  const R = ruhModel();
  const warn = { status: 409, json: { error: { code: 'RUH_CONFIRM_REQUIRED', message: 'm', details: { risks: [{ code: 'X', title: 'T', detail: 'D', severity: 'warn' }] } } } };
  assert.equal(R.needsConfirm(warn), true);
  assert.equal(R.needsConfirm({ status: 409, json: { error: { code: 'CONFLICT' } } }), false);
  assert.equal(R.needsConfirm({ status: 200, json: {} }), false);
  const o = R.withOverride({ method: 'POST', body: { formulaId: 'f', reason: 'swap' } }, 'customer collecting today');
  assert.deepEqual(JSON.parse(JSON.stringify(o)), { method: 'POST', body: { formulaId: 'f', reason: 'swap', ruhOverride: { reason: 'customer collecting today' } }, ruhConfirmed: true });
  assert.deepEqual(JSON.parse(JSON.stringify(R.withOverride({ method: 'POST' }, 'reason given here'))).body, { ruhOverride: { reason: 'reason given here' } });

  let asked: any = null;
  R.confirm = (err: any, opts: any) => { asked = { err, opts }; return Promise.resolve('going ahead, agreed'); };
  let sent: any = null;
  const res = await R.guard(warn, { method: 'POST', body: { reason: 'swap' } }, (x: any) => { sent = x; return Promise.resolve({ status: 200, json: { data: { ok: true } } }); });
  assert.equal(res.status, 200);
  assert.equal(sent.body.ruhOverride.reason, 'going ahead, agreed');
  assert.equal(asked.opts.prefill, 'swap', 'the action\'s own reason is offered as a start');
  R.confirm = () => Promise.resolve(null);
  const no = await R.guard(warn, { method: 'POST' }, () => { throw new Error('must not resend'); });
  assert.deepEqual(JSON.parse(JSON.stringify(no)), { status: 409, json: { data: null, error: { code: 'RUH_CANCELLED', message: 'Not done: you chose not to go ahead.' } } });
  const passthrough = await R.guard({ status: 201, json: {} }, {}, () => { throw new Error('no'); });
  assert.equal(passthrough.status, 201);
});

test('the Vault: its own notes only, from the main box; no settings there', () => {
  const js = read('web-vault/vault.js');
  const block = js.slice(js.indexOf('function ruhStart()'), js.indexOf('async function render()'));
  assert.match(block, /console: 'vault'/);
  assert.match(block, /return mainTunnel\(path,/);
  assert.match(block, /canSettings: function \(\) \{ return false; \}/);
  assert.match(read('web/ruh.js'), /if \(cfg\.console === 'vault'\) q\.push\('console=vault'\);/);
});

test('Factory deep links open the first section the workspace has, then find the record; rows carry their ids', () => {
  const shell = read('web/shell.js');
  assert.match(shell, /var m = \/\^#\\\/go\\\/\(\[\^\/\]\+\)\(\?:\\\/\(\.\+\)\)\?\$\/\.exec/);
  assert.match(shell, /RaRuh\.focusRecord\(decodeURIComponent\(m\[2\]\), \$\('ra-view'\)\)/);
  assert.match(shell, /var rid = guessId\(r\); return '<tr' \+ \(rid \? ' data-rid="' \+ escHtml\(rid\) \+ '"' : ''\)/);
  assert.match(read('web/ws-produce.js'), /'<tr data-ruh-id="' \+ escHtml\(r\.alembicRequirementId\) \+ '">'/);
  assert.match(read('web/ws-formula-setup.js'), /'<tr data-ruh-id="' \+ escHtml\(p\.productId\) \+ '">/);
});

test('ruh.js: tunnel only, urgent-only sound after a gesture, its own mute, polling paused when hidden', () => {
  const js = code(read('web/ruh.js'));
  assert.ok(!/\bfetch\(/.test(js), 'every call goes through the console\'s encrypted tunnel');
  assert.match(js, /function chime\(\) \{ if \(ruhSoundOn\(\) && g\.RaSound\) g\.RaSound\.play\('alert'\); \}/);
  assert.equal((js.match(/chime\(\)/g) || []).length, 2, 'declared once, played only by the urgent pop-up');
  assert.match(js, /if \(!state\.seen\[i\.id\] && i\.status === 'open' && i\.severity === 'urgent'\) fresh\.push\(i\);/);
  assert.match(js, /if \(!g\.document\.hidden\) refresh\(false\);/);
  assert.match(js, /var MUTE_KEY = 'rac\.ruh\.sound\.v1';/);
});

test('ruh.js shows no developer text (no table, schema, file, ticket or lane names; no snake_case)', () => {
  const js = code(read('web/ruh.js'));
  const strings = [...js.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1] ?? '')
    .filter((s) => !s.startsWith('/v1/') && !/^[a-z]+(\.[a-zA-Z]+)+$/.test(s) && !/^[a-z-]+$/.test(s) && !/^(ra-|ruh-|data-|aria-)/.test(s)
      && !/^[.#@\-a-z0-9 ,:;()%"=\[\]{}>+*!|~^$/\\]*\{/.test(s) && !/^M[\d. ]/.test(s) && !/^m6 6/.test(s));
  const leaks = strings.filter((s) =>
    /\b(production|packaging|bridge|masterdata|location|iam|platform)\.[a-z_]+\b/.test(s)
    || /\b[a-z]+_[a-z_]+\b/.test(s)
    || /\.(ts|sql|md)\b/.test(s)
    || /\b(RP-[A-Z0-9]+|PB-\d+|lane\b|C3|C4)/.test(s));
  assert.deepEqual(leaks, []);
  for (const words of ['All clear. Ruh is watching and will tell you when something needs you.', 'Ruh has a warning',
    'You can go ahead: Ruh never blocks. Type why, and your reason goes to the admins with this warning.', 'Your reason is kept and the admins are told.']) {
    assert.ok(js.includes(words), words);
  }
});
