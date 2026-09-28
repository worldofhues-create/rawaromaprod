/**
 * Focus mode + app windows for the static consoles (owner requirement 2026-09-29: "all consoles always open in
 * full screen mode on all browsers, hiding the address bar etc — like a focus mode").
 *
 * Static, like nginx-security-headers.test.ts: no browser on the gate machines. focus.js is run in a `vm` context
 * (with no document it publishes only its pure decisions; with a small fake DOM it boots for real), and each
 * service worker is run in a `vm` context with fake `caches`/`fetch` and fed fetch events.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const CONSOLES = [
  { dir: 'web', app: 'RAW Factory', script: 'shell.js', sw: true, host: 'https://rawfactory.huecycle.in' },
  { dir: 'web-platform', app: 'RAW Platform', script: 'platform.js', sw: true, host: 'https://rawplatform.huecycle.in' },
  { dir: 'web-vault', app: 'RAW Vault', script: 'vault.js', sw: false, host: 'https://rawvault.huecycle.in' },
] as const;

// ── focus.js: pure decisions ─────────────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function pureFocus(): any {
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(read('web/focus.js'), ctx);
  return ctx.RaFocus;
}

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
};

test('browserKind picks the install instructions per browser', () => {
  const F = pureFocus();
  assert.equal(F.browserKind({ ua: UA.chromeMac }), 'chrome');
  assert.equal(F.browserKind({ ua: UA.edgeWin }), 'edge');
  assert.equal(F.browserKind({ ua: UA.safariMac, platform: 'MacIntel', maxTouchPoints: 0 }), 'safari-mac');
  // iPadOS Safari reports a Mac UA; touch points give it away.
  assert.equal(F.browserKind({ ua: UA.safariMac, platform: 'MacIntel', maxTouchPoints: 5 }), 'ios');
  assert.equal(F.browserKind({ ua: UA.firefoxWin }), 'firefox');
  assert.equal(F.browserKind({ ua: UA.firefoxAndroid }), 'firefox-android');
  assert.equal(F.browserKind({ ua: UA.iphone }), 'ios');
  assert.equal(F.browserKind({ ua: UA.iphoneChrome }), 'ios');
  assert.equal(F.browserKind({ ua: UA.androidChrome }), 'android');
  assert.equal(F.browserKind({ ua: 'curl/8' }), 'other');
  assert.match(F.installHelp('chrome', 'RAW Factory'), /Install page as app/);
  assert.match(F.installHelp('edge', 'RAW Factory'), /Apps > Install this site as an app/);
  assert.match(F.installHelp('safari-mac', 'RAW Vault'), /File > Add to Dock/);
  assert.match(F.installHelp('ios', 'RAW Vault'), /Share, then Add to Home Screen/);
  assert.match(F.installHelp('firefox', 'RAW Platform'), /cannot install.*Focus mode/s);
});

const BASE = { pref: true, sessionOff: false, appWindow: false, iphone: false, fsEnabled: true, inFullscreen: false, hash: '', hidden: false, skipTarget: false };

test('focusDecision: full screen on a plain click, with every exception', () => {
  const F = pureFocus();
  assert.deepEqual({ ...F.focusDecision(BASE) }, { go: true, why: 'go' });
  const cases: Array<[Partial<typeof BASE>, string]> = [
    [{ pref: false }, 'pref-off'],
    [{ sessionOff: true }, 'session-off'],
    [{ appWindow: true }, 'app-window'],
    [{ iphone: true }, 'iphone'],
    [{ fsEnabled: false }, 'unsupported'],   // also what a Permissions-Policy fullscreen=() looks like
    [{ inFullscreen: true }, 'already'],
    [{ hash: '#assertion=eyJhbGciOi' }, 'handoff'],
    [{ hash: '#x=1&assertion=abc' }, 'handoff'],
    [{ hidden: true }, 'hidden'],
    [{ skipTarget: true }, 'skip-target'],
  ];
  for (const [delta, why] of cases) {
    const r = F.focusDecision({ ...BASE, ...delta });
    assert.equal(r.go, false, JSON.stringify(delta));
    assert.equal(r.why, why, JSON.stringify(delta));
  }
  // A console route in the hash is not a hand-off.
  assert.equal(F.focusDecision({ ...BASE, hash: '#/formulas' }).go, true);
});

test('escTurnsOff: a second Esc within 3 s of leaving full screen, unless closing something in the page', () => {
  const F = pureFocus();
  const t = 1_000_000;
  assert.equal(F.escTurnsOff({ lastUserExitAt: null, now: t, overlayOpen: false }), false);
  assert.equal(F.escTurnsOff({ lastUserExitAt: t - 50, now: t, overlayOpen: false }), false, 'same press');
  assert.equal(F.escTurnsOff({ lastUserExitAt: t - 800, now: t, overlayOpen: false }), true);
  assert.equal(F.escTurnsOff({ lastUserExitAt: t - 3000, now: t, overlayOpen: false }), true);
  assert.equal(F.escTurnsOff({ lastUserExitAt: t - 3001, now: t, overlayOpen: false }), false);
  assert.equal(F.escTurnsOff({ lastUserExitAt: t - 800, now: t, overlayOpen: true }), false, 'Esc closed a dialog');
});

test('installOffer: until installed, re-offered a week after "Not now"', () => {
  const F = pureFocus();
  const now = Date.UTC(2026, 8, 29);
  const week = 7 * 24 * 3600 * 1000;
  assert.equal(F.REOFFER_MS, week);
  assert.equal(F.installOffer({ appWindow: false, installed: false, dismissedAt: null, now }), true);
  assert.equal(F.installOffer({ appWindow: true, installed: false, dismissedAt: null, now }), false);
  assert.equal(F.installOffer({ appWindow: false, installed: true, dismissedAt: null, now }), false);
  assert.equal(F.installOffer({ appWindow: false, installed: false, dismissedAt: now - week + 1, now }), false);
  assert.equal(F.installOffer({ appWindow: false, installed: false, dismissedAt: now - week, now }), true);
  assert.equal(F.installOffer({ appWindow: false, installed: false, dismissedAt: NaN, now }), true);
});

// ── focus.js: booted against a small fake DOM ────────────────────────────────────────────────────────────────────

interface Rig { fire(type: string, ev: Record<string, unknown>): void; setNow(t: number): void; requests: number; exits: number; local: Map<string, string>; session: Map<string, string>; doc: any; win: any }

function bootFocus(opts: { ua?: string; hash?: string; standalone?: boolean; fsEnabled?: boolean; pref?: string; overlay?: boolean } = {}): Rig {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  if (opts.pref) local.set('rac.console.focus.v1', opts.pref);
  const storage = (m: Map<string, string>) => ({ getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } });
  const el = (): any => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const node: any = {
      style: {}, hidden: false, children: [] as unknown[], parentNode: null,
      setAttribute: (k: string, v: string) => attrs.set(k, v), getAttribute: (k: string) => attrs.get(k) ?? null,
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
      appendChild: (c: any) => { node.children.push(c); c.parentNode = node; return c; },
      insertBefore: (c: any) => { node.children.unshift(c); c.parentNode = node; return c; },
      removeChild: (c: any) => { node.children = node.children.filter((x: unknown) => x !== c); },
      get firstChild() { return node.children[0] ?? null; },
      closest: () => null,
    };
    return node;
  };
  const rig: Rig = { requests: 0, exits: 0, local, session } as Rig;
  const docEl = el();
  docEl.requestFullscreen = () => { rig.requests++; return Promise.resolve(); };
  const doc: any = {
    documentElement: docEl, body: el(), head: el(), title: 'Console', hidden: false,
    fullscreenEnabled: opts.fsEnabled !== false, fullscreenElement: null,
    currentScript: { getAttribute: (k: string) => (k === 'data-app' ? 'RAW Test' : null) },
    createElement: () => el(), getElementById: () => null,
    querySelector: (sel: string) => (opts.overlay && sel.includes('aria-modal') ? {} : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ||= []).push(fn); },
    exitFullscreen: () => { rig.exits++; doc.fullscreenElement = null; return Promise.resolve(); },
  };
  const win: any = {
    document: doc,
    navigator: { userAgent: opts.ua ?? UA.chromeMac, platform: 'MacIntel', maxTouchPoints: 0 },
    location: { hash: opts.hash ?? '' },
    localStorage: storage(local), sessionStorage: storage(session),
    matchMedia: (q: string) => ({ matches: !!opts.standalone && q.includes('standalone') }),
    addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners['win:' + t] ||= []).push(fn); },
    setTimeout: () => 0, clearTimeout: () => undefined,
  };
  win.window = win;
  vm.runInNewContext(read('web/focus.js'), win);
  rig.fire = (type, ev) => { for (const fn of listeners[type] ?? []) fn(ev); };
  // focus.js reads the context's own Date; pin it.
  rig.setNow = (t) => { vm.runInContext(`Date.now = function () { return ${t}; };`, win); };
  rig.doc = doc;
  rig.win = win;
  return rig;
}

const plain = { isTrusted: true, target: { closest: () => null } };
const onLink = { isTrusted: true, target: { closest: (s: string) => (s.includes('a[href]') ? {} : null) } };

test('focus.js boot: the first plain click requests full screen on the document root', () => {
  const r = bootFocus();
  r.fire('click', plain);
  assert.equal(r.requests, 1);
});

test('focus.js boot: the sign-in hand-off is never disturbed', () => {
  // "Sign in via ALEMBIC" / ?open= return link / "Open ALEMBIC" are links or data-focus-skip: no request.
  const r1 = bootFocus();
  r1.fire('click', onLink);
  assert.equal(r1.requests, 0);
  // An #assertion= fragment still waiting to be consumed: no request.
  const r2 = bootFocus({ hash: '#assertion=eyJ0eXAi' });
  r2.fire('click', plain);
  assert.equal(r2.requests, 0);
  // Synthetic (script-dispatched) clicks never count.
  const r3 = bootFocus();
  r3.fire('click', { ...plain, isTrusted: false });
  assert.equal(r3.requests, 0);
  // The file itself never touches navigation, cookies, network or caches.
  const code = read('web/focus.js').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  for (const banned of [/location\s*\.\s*(assign|replace|href\s*=|hash\s*=)/, /location\s*=/, /history\./, /document\.cookie/, /\bfetch\(/, /\bcaches\b/, /XMLHttpRequest/, /serviceWorker/]) {
    assert.doesNotMatch(code, banned, `focus.js must not use ${banned}`);
  }
});

test('focus.js boot: skipped in an app window, on iPhone, when blocked, and when switched off', () => {
  for (const o of [{ standalone: true }, { ua: UA.iphone }, { fsEnabled: false }, { pref: '0' }]) {
    const r = bootFocus(o);
    r.fire('click', plain);
    assert.equal(r.requests, 0, JSON.stringify(o));
  }
});

test('focus.js boot: second Esc within 3 s turns focus mode off for the session; Esc closing a dialog does not', () => {
  const r = bootFocus();
  r.fire('click', plain);
  // The browser entered full screen, then the user pressed Esc (the browser leaves full screen).
  r.doc.fullscreenElement = r.doc.documentElement;
  r.fire('fullscreenchange', {});
  r.doc.fullscreenElement = null;
  r.setNow(1_000_000);
  r.fire('fullscreenchange', {});
  // Second Esc a moment later (the page does see this one).
  r.setNow(1_000_600);
  r.fire('keydown', { key: 'Escape' });
  assert.equal(r.session.get('rac.console.focus.session-off'), '1');
  r.fire('click', plain);
  assert.equal(r.requests, 1, 'no new request once off for the session');
  assert.equal(r.local.get('rac.console.focus.v1'), undefined, 'the saved preference is untouched');

  // A slow second Esc (after 3 s) does nothing.
  const slow = bootFocus();
  slow.doc.fullscreenElement = slow.doc.documentElement;
  slow.fire('fullscreenchange', {});
  slow.doc.fullscreenElement = null;
  slow.setNow(2_000_000);
  slow.fire('fullscreenchange', {});
  slow.setNow(2_003_500);
  slow.fire('keydown', { key: 'Escape' });
  assert.equal(slow.session.get('rac.console.focus.session-off'), undefined);

  const r2 = bootFocus({ overlay: true });
  r2.doc.fullscreenElement = r2.doc.documentElement;
  r2.fire('fullscreenchange', {});
  r2.doc.fullscreenElement = null;
  r2.setNow(1_000_000);
  r2.fire('fullscreenchange', {});
  r2.setNow(1_000_600);
  r2.fire('keydown', { key: 'Escape' });
  assert.equal(r2.session.get('rac.console.focus.session-off'), undefined);
});

test('focus.js boot: the menu switch turns focus mode off (remembered) and back on (enters at once)', () => {
  const r = bootFocus();
  const parent = r.doc.createElement('div');
  const b = r.win.RaFocus.mountToggle(parent, null, 'rail-min', '');
  assert.ok(b);
  assert.equal(b.getAttribute('aria-pressed'), 'true', 'default on');
  r.doc.fullscreenElement = r.doc.documentElement;
  b.onclick();
  assert.equal(r.local.get('rac.console.focus.v1'), '0');
  assert.equal(r.exits, 1);
  r.fire('click', plain);
  assert.equal(r.requests, 0);
  b.onclick();
  assert.equal(r.local.get('rac.console.focus.v1'), '1');
  assert.equal(r.requests, 1, 'the switch click itself enters full screen');
});

// ── wiring: identical copies, script tags, menu switches ─────────────────────────────────────────────────────────

test('every console ships the same focus.js, loads it before its console script, and mounts the menu switch', () => {
  const master = read('web/focus.js');
  for (const c of CONSOLES) {
    assert.equal(read(`${c.dir}/focus.js`), master, `${c.dir}/focus.js differs from web/focus.js`);
    const html = read(`${c.dir}/index.html`);
    const tag = `<script src="/focus.js" data-app="${c.app}"></script>`;
    assert.ok(html.includes(tag), `${c.dir}/index.html lacks ${tag}`);
    assert.ok(html.indexOf(tag) < html.indexOf(`<script src="/${c.script}"`), `${c.dir}: focus.js must load before ${c.script}`);
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    assert.match(read(`${c.dir}/${c.script}`), /RaFocus\.mountToggle\(/, `${c.dir}/${c.script} never mounts the focus switch`);
  }
  // The Vault's nginx sub_filter anchors on this exact tag; it must still be there, unchanged.
  assert.ok(read('web-vault/index.html').includes('<script src="/vault.js"></script>'));
  // The Vault's step-up exit to ALEMBIC is marked so focus mode never fires on it.
  assert.match(read('web-vault/vault.js'), /'data-focus-skip': ''[^\n]*\n[^\n]*\n\s*if \(ALEMBIC_CONSOLE_URL\) location\.assign\(alembicSignInUrl\('vault'\)\)/);
});

// ── manifests ────────────────────────────────────────────────────────────────────────────────────────────────────

function pngSize(p: string): [number, number] {
  const b = readFileSync(join(ROOT, p));
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${p} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('each console has a valid, installable web app manifest', () => {
  for (const c of CONSOLES) {
    const m = JSON.parse(read(`${c.dir}/manifest.webmanifest`));
    assert.equal(m.name, c.app);
    assert.equal(m.short_name, c.app);
    assert.equal(m.id, '/');
    assert.equal(m.start_url, '/');
    assert.equal(m.scope, '/');
    const start = new URL(m.start_url, c.host);
    assert.ok(start.href.startsWith(new URL(m.scope, c.host).href), 'start_url inside scope');
    assert.equal(start.origin, c.host, 'start_url on the console origin');
    assert.equal(m.display, 'standalone');
    assert.deepEqual(m.display_override, ['window-controls-overlay', 'standalone']);
    assert.notEqual(m.prefer_related_applications, true);
    assert.match(m.theme_color, /^#[0-9A-Fa-f]{6}$/);
    assert.match(m.background_color, /^#[0-9A-Fa-f]{6}$/);
    const need = new Set(['192x192 any', '512x512 any', '192x192 maskable', '512x512 maskable']);
    for (const i of m.icons) {
      assert.equal(i.type, 'image/png');
      assert.ok(i.src.startsWith('/'), 'root-relative icon');
      const [w, h] = pngSize(`${c.dir}${i.src}`);
      assert.equal(`${w}x${h}`, i.sizes, `${c.dir}${i.src} is ${w}x${h}, manifest says ${i.sizes}`);
      need.delete(`${i.sizes} ${i.purpose}`);
    }
    assert.deepEqual([...need], [], `${c.dir}: missing icons`);
    assert.deepEqual(pngSize(`${c.dir}/apple-touch-icon.png`), [180, 180]);
    // Same RAW mark everywhere (the icons are copies of one set).
    assert.deepEqual(readFileSync(join(ROOT, `${c.dir}/icon-512.png`)), readFileSync(join(ROOT, 'web/icon-512.png')));
  }
});

// ── service workers ──────────────────────────────────────────────────────────────────────────────────────────────

const NETWORK_ONLY = [
  ['GET', '/rpc'], ['POST', '/rpc'], ['GET', '/rpc/x'], ['POST', '/crypto/handshake'], ['GET', '/crypto/x'],
  ['GET', '/main/rpc'], ['POST', '/main/rpc'], ['POST', '/main/crypto/handshake'], ['GET', '/main/anything'],
  ['GET', '/v1/formulas'], ['GET', '/auth/me'], ['GET', '/health'], ['GET', '/console-config.js'],
];

function runSw(dir: string, host: string) {
  const handlers: Record<string, (e: any) => void> = {};
  const puts: string[] = [];
  const precached: string[] = [];
  const cache = {
    put: (req: any) => { puts.push(typeof req === 'string' ? req : req.url); return Promise.resolve(); },
    add: (u: string) => { precached.push(u); return Promise.resolve(); },
    addAll: (us: string[]) => { precached.push(...us); return Promise.resolve(); },
  };
  const res = { status: 200, clone() { return res; } };
  const self: any = {
    location: new URL('/', host),
    addEventListener: (t: string, fn: (e: any) => void) => { handlers[t] = fn; },
    skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() },
  };
  const ctx = {
    self, URL, Promise,
    caches: { open: () => Promise.resolve(cache), match: () => Promise.resolve(undefined), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) },
    fetch: () => Promise.resolve(res),
  };
  vm.runInNewContext(read(`${dir}/sw.js`), ctx);
  return { handlers, puts, precached };
}

test('service workers never cache or answer /rpc, /main/*, /crypto/* or any API path', async () => {
  for (const c of CONSOLES.filter((x) => x.sw)) {
    const sw = runSw(c.dir, c.host);
    let waited: Promise<unknown> = Promise.resolve();
    sw.handlers.install!({ waitUntil: (p: Promise<unknown>) => { waited = p; } });
    await waited;
    assert.ok(sw.precached.includes('/focus.js'), `${c.dir}/sw.js precaches focus.js`);
    for (const u of sw.precached) assert.doesNotMatch(u, /^\/(rpc|main|crypto|v1|auth|health)\b/, `${c.dir} precaches ${u}`);

    for (const [method, path] of NETWORK_ONLY) {
      let answered = false;
      sw.handlers.fetch!({ request: { url: c.host + path, method, mode: 'cors' }, respondWith: () => { answered = true; } });
      assert.equal(answered, false, `${c.dir}/sw.js intercepted ${method} ${path}`);
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sw.puts, [], `${c.dir}/sw.js cached ${sw.puts.join(', ')}`);

    // Sanity: the shell itself is still served through the worker (so the probe above is meaningful).
    let answered = false;
    sw.handlers.fetch!({ request: { url: c.host + '/focus.js', method: 'GET', mode: 'no-cors' }, respondWith: (p: Promise<unknown>) => { answered = true; void p; } });
    assert.equal(answered, true, `${c.dir}/sw.js no longer serves /focus.js`);
  }
});

test('the Vault stays without a service worker: none shipped, none registered, strays unregistered', () => {
  assert.equal(existsSync(join(ROOT, 'web-vault/sw.js')), false);
  const js = read('web-vault/vault.js') + read('web-vault/index.html') + read('web-vault/focus.js');
  assert.doesNotMatch(js, /serviceWorker\.register\(/);
  assert.match(read('web-vault/vault.js'), /getRegistrations\(\)\.then\(function \(regs\) \{\s*regs\.forEach\(function \(r\) \{ r\.unregister\(\); \}\);/);
});

// ── nginx headers the consoles are served with ───────────────────────────────────────────────────────────────────

test('nginx lets the consoles go full screen and load their manifest', () => {
  for (const f of ['security-headers-factory.conf', 'security-headers-platform.conf', 'security-headers-vault.conf']) {
    const conf = read(`infra/aws/nginx/${f}`).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const pp = /add_header\s+Permissions-Policy\s+"([^"]*)"/.exec(conf)?.[1];
    if (pp !== undefined) {
      assert.doesNotMatch(pp, /fullscreen=\(\)/, `${f} disables the Fullscreen API`);
      assert.match(pp, /fullscreen=\(self\)/, `${f} should allow fullscreen for self`);
    }
    const csp = /add_header\s+Content-Security-Policy\s+"([^"]*)"/.exec(conf)?.[1];
    if (csp !== undefined) {
      // manifest-src / worker-src fall back to default-src; either way 'self' must be allowed.
      for (const d of ['manifest-src', 'worker-src']) {
        const own = new RegExp(`${d}\\s+([^;]*)`).exec(csp)?.[1];
        const eff = own ?? /default-src\s+([^;]*)/.exec(csp)?.[1] ?? '';
        assert.match(eff, /'self'/, `${f}: ${d} does not allow 'self'`);
      }
      assert.match(csp, /img-src[^;]*'self'/, `${f}: manifest icons need img-src 'self'`);
    }
  }
});
