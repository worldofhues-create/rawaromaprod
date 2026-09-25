/**
 * RC7 security item — the Vault consoles' `/main/` channel reaches exactly what vault.js uses, nothing more.
 *
 * rawvault.huecycle.in (and the demo's rawdemovault) proxy the console's MAIN_API channel (`window.MAIN_API =
 * '/main'`) to the MAIN RawProd API on the app box. It used to be `location /main/ { proxy_pass http://<main>/; }`:
 * every route of the main API, under a second public name, around the CloudFront origin's own path allowlist
 * (rawprod-cf-origin.conf) and its origin-secret check. vault.js only ever talks to a backend through its encrypted
 * tunnel — `POST <base>/crypto/handshake` and `POST <base>/rpc`; sign-in (/auth/alembic-assertion, /me) and Ask Aria
 * travel inside the /rpc envelope — so those two wire paths are all `/main/` may reach.
 *
 * Static, like nginx-security-headers.test.ts (no nginx binary on the gate machines): the vhost's top-level
 * locations are parsed, and nginx's own location selection is applied to probe URIs — exact `=` first, then the
 * longest prefix, which wins outright when it is `^~`, else the first matching regex in file order, else that
 * longest prefix. Each probe under /main/ must land on a 404 or on one of the two channel locations, and those
 * must forward the same path with the /main prefix stripped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

interface Loc { mod: '' | '=' | '^~' | '~' | '~*'; pattern: string; body: string }

/** The top-level locations of the vhost's TLS server block, in file order. No location in these files nests a
 *  block, so a location body ends at its first `}`. Comments are dropped first (none sits inside a quoted value). */
function tlsLocations(conf: string): Loc[] {
  const text = conf.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  const servers = text.match(/server\s*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
  const tls = servers.filter((s) => /listen\s+443/.test(s));
  assert.equal(tls.length, 1, 'expected exactly one TLS server block');
  const out: Loc[] = [];
  for (const m of (tls[0] as string).matchAll(/location\s+(=|\^~|~\*|~)?\s*(\S+)\s*\{([^}]*)\}/g)) {
    out.push({ mod: (m[1] ?? '') as Loc['mod'], pattern: m[2] as string, body: (m[3] as string).trim() });
  }
  return out;
}

/** nginx's location selection for a (normalised) URI. */
function select(locs: Loc[], uri: string): Loc | undefined {
  const exact = locs.find((l) => l.mod === '=' && l.pattern === uri);
  if (exact) return exact;
  const prefixes = locs.filter((l) => (l.mod === '' || l.mod === '^~') && uri.startsWith(l.pattern));
  const longest = prefixes.sort((a, b) => b.pattern.length - a.pattern.length)[0];
  if (longest?.mod === '^~') return longest;
  const regex = locs.find((l) => (l.mod === '~' || l.mod === '~*') && new RegExp(l.pattern, l.mod === '~*' ? 'i' : '').test(uri));
  return regex ?? longest;
}

const proxyTarget = (l: Loc) => /proxy_pass\s+([^;]+);/.exec(l.body)?.[1];
const is404 = (l: Loc | undefined) => !!l && /(^|\s|;)return\s+404\s*;/.test(l.body) && !proxyTarget(l);

const VHOSTS = [
  { file: 'infra/aws/nginx/rawvault.conf', main: 'rawprod_api_cf' },
  { file: 'infra/aws/nginx/rawdemovault.conf', main: 'rawprod_demo_api' },
];

/** The wire paths vault.js sends to a backend channel: `fetch(base + '<path>'`. */
function channelWirePaths(): string[] {
  const js = read('web-vault/vault.js');
  return [...js.matchAll(/fetch\(\s*base\s*\+\s*'([^']+)'/g)].map((m) => m[1] as string).sort();
}

test('vault.js reaches a backend only through the tunnel: /crypto/handshake and /rpc', () => {
  assert.deepEqual(channelWirePaths(), ['/crypto/handshake', '/rpc']);
  const js = read('web-vault/vault.js');
  // MAIN_API is used only to build that channel, never fetched directly.
  const uses = [...js.matchAll(/\bMAIN_API\b/g)].length;
  const declared = /var MAIN_API = \(typeof window\.MAIN_API === 'string'\) \? window\.MAIN_API : API;/.test(js);
  assert.ok(declared, 'MAIN_API declaration moved; re-check what the console sends to /main/');
  assert.match(js, /makeChannel\(MAIN_API\)/);
  const code = js.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.equal([...code.matchAll(/\bMAIN_API\b/g)].length, 4, `unexpected MAIN_API use (${uses} mentions)`);
  assert.doesNotMatch(code, /fetch\(\s*MAIN_API/);
  // Both deploy configs point the channel at /main.
  for (const f of ['infra/aws/nginx/static-config/vault/vault-config.js', 'infra/aws/nginx/static-config/demo-vault/vault-config.js']) {
    assert.match(read(f), /window\.MAIN_API = '\/main';/, f);
  }
});

for (const { file, main } of VHOSTS) {
  test(`${file}: only the tunnel's two paths reach the main API; the rest of /main/ is a 404`, () => {
    const locs = tlsLocations(read(file));
    const toMain = locs.filter((l) => proxyTarget(l)?.startsWith(`http://${main}`));
    assert.deepEqual(
      toMain.map((l) => `${l.mod} ${l.pattern} -> ${proxyTarget(l)}`).sort(),
      channelWirePaths().map((p) => `= /main${p} -> http://${main}${p}`).sort(),
      'the main-API locations must be exactly the channel paths, exact-match, prefix stripped',
    );
    for (const l of toMain) assert.match(l.body, /limit_req zone=\w+ /, `${l.pattern} lost its rate limit`);

    const allowed = new Set(channelWirePaths().map((p) => `/main${p}`));
    const probes = [
      '/main/', '/main/rpc', '/main/crypto/handshake', '/main/crypto/', '/main/crypto/handshake/x', '/main/rpc/x',
      '/main/rpcx', '/main/me', '/main/auth/alembic-assertion', '/main/auth/refresh', '/main/auth/login',
      '/main/v1/formulas', '/main/v1/aria/ask', '/main/v1/platform/status', '/main/health', '/main/internal/vault/x',
      '/main/.env', '/main/index.html',
    ];
    for (const uri of probes) {
      const loc = select(locs, uri);
      if (allowed.has(uri)) {
        assert.equal(loc?.mod, '=', `${uri} must be an exact-match location`);
        assert.equal(proxyTarget(loc as Loc), `http://${main}${uri.slice('/main'.length)}`, uri);
      } else {
        assert.ok(is404(loc), `${uri} must be a 404, got ${loc ? `${loc.mod} ${loc.pattern} { ${loc.body} }` : 'no location'}`);
      }
    }
  });

  test(`${file}: the Vault API paths still go to the vault box`, () => {
    const locs = tlsLocations(read(file));
    for (const uri of ['/rpc', '/crypto/handshake', '/v1/formulas', '/auth/alembic-assertion', '/health']) {
      const target = proxyTarget(select(locs, uri) as Loc) ?? '';
      assert.match(target, /^http:\/\/raw(demo)?vault_api_private$/, `${uri} -> ${target}`);
    }
  });
}
