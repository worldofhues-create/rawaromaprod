/**
 * Lane platform-roles (2026-09-28) — the three consoles' sign-in wiring, read from their source:
 *   - "Sign in via ALEMBIC" goes to <ALEMBIC_CONSOLE_URL>?open=<console> (docs/bridge/CONSOLE_SIGN_IN.md),
 *     built from the deploy config, so ALEMBIC hands the person straight back in the same tab;
 *   - Factory and Platform keep their session in the tunnel's HttpOnly cookie (persist on /auth/*)
 *     and never hold a refresh token in web storage; the Vault never persists (§109.4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const src = {
  factory: readFileSync(join(root, 'web', 'shell.js'), 'utf8'),
  platform: readFileSync(join(root, 'web-platform', 'platform.js'), 'utf8'),
  vault: readFileSync(join(root, 'web-vault', 'vault.js'), 'utf8'),
};

/** Run a console's own alembicSignInUrl() against a given ALEMBIC_CONSOLE_URL. */
function signInUrl(source: string, configured: string, target: string): string {
  const fn = /function alembicSignInUrl\(target\) \{[\s\S]*?\n  \}\n/.exec(source);
  assert.ok(fn, 'alembicSignInUrl is defined');
  const ctx = { URL, location: { href: 'https://rawfactory.huecycle.in/' }, ALEMBIC_CONSOLE_URL: configured, out: '' };
  vm.runInNewContext(`${fn[0]}; out = alembicSignInUrl(${JSON.stringify(target)});`, ctx);
  return ctx.out;
}

for (const [name, source] of Object.entries(src)) {
  test(`${name}: the sign-in link asks ALEMBIC to open ${name} (?open=${name}), from the configured URL`, () => {
    assert.match(source, new RegExp(`alembicSignInUrl\\('${name}'\\)`));
    assert.doesNotMatch(source, /href: ALEMBIC_CONSOLE_URL|href="' \+ \(ALEMBIC_CONSOLE_URL/, 'no bare link to ALEMBIC left');
    assert.equal(signInUrl(source, 'https://rawadmin.huecycle.in/admin', name), `https://rawadmin.huecycle.in/admin?open=${name}`);
    assert.equal(signInUrl(source, 'https://rawdemoadmin.huecycle.in/admin?x=1', name), `https://rawdemoadmin.huecycle.in/admin?x=1&open=${name}`);
    assert.equal(signInUrl(source, '', name), '', 'unconfigured stays an honest "not set up"');
  });
}

test('factory + platform: session kept via the tunnel cookie; no refresh token in web storage', () => {
  for (const source of [src.factory, src.platform]) {
    assert.match(source, /if \(path\.indexOf\('\/auth\/'\) === 0\) (p|payload)\.persist = true;/);
    assert.doesNotMatch(source, /localStorage\.setItem\('ra_rt'|localStorage\.getItem\('ra_rt'|refreshToken: rt/);
    assert.match(source, /'\/auth\/refresh', \{ method: 'POST' \}/, 'restores from the cookie with no token in the body');
    assert.match(source, /'\/auth\/logout'/, 'sign-out clears the cookie');
  }
});

test('vault: never asks to persist; the step-up round trip returns in the same tab', () => {
  assert.doesNotMatch(src.vault, /persist\s*=\s*true/);
  assert.doesNotMatch(src.vault, /localStorage\.setItem|sessionStorage\.setItem/);
  assert.match(src.vault, /location\.assign\(alembicSignInUrl\('vault'\)\)/);
  assert.doesNotMatch(src.vault, /window\.open\(ALEMBIC_CONSOLE_URL/);
});
