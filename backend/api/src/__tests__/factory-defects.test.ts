/**
 * Defects found documenting the console. Static over the shipped sources, like console-routes.test.ts;
 * e2e/specs/factory/factory-defects.spec.ts walks the same things on the real stack.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';
import { CAPABILITY_PERMISSIONS, ROLES } from '../../../../scripts/ra-roles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const ALL = [...new Set([...RA_PERMISSIONS, ...CAPABILITY_PERMISSIONS])];
const grantsOf = (code: string) => ALL.filter((p) => ROLES.find((r) => r.code === code)!.select(p));

/** Every `@Get('v1/...')` on the main API, with its read permission. The Vault's cluster is not on it. */
function mainRoutes() {
  const files = execFileSync('grep', ['-rlE', "@Get\\('v1/", 'backend', '--include=*.controller.ts', '--exclude-dir=node_modules', '--exclude-dir=cluster-formula'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const map = new Map<string, string>();
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      const m = /@Get\('(v1\/[^':]*)'\)/.exec(l);
      if (!m) return;
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        const q = /@Permissions\('([^']+)'/.exec(lines[j]!);
        if (q) { map.set(`/${m[1]}`, q[1]!); return; }
      }
      map.set(`/${m[1]}`, '');
    });
  }
  return map;
}
function rail(role: string) {
  const s = read('web/shell.js');
  const a = s.indexOf(`    ${role}: { label:`);
  return [...s.slice(a, s.indexOf('] ] }', a)).matchAll(/\['\w+', '([^']+)', '\w+', '(\/v1[^']+)'/g)].map((m) => ({ label: m[1]!, path: m[2]! }));
}

test('every Owner rail entry has a route on the main API, and the Owner holds its read', () => {
  const routes = mainRoutes();
  const owner = new Set(grantsOf('owner'));
  for (const { label, path } of rail('superadmin')) {
    assert.ok(routes.has(path), `${label}: ${path} is not on the main API`);
    const perm = routes.get(path)!;
    if (perm) assert.ok(owner.has(perm), `${label}: owner lacks ${perm}`);
  }
});

test('the Owner is still refused formula:actual:read, so hiding Notifications was the only alignment', () => {
  assert.ok(!grantsOf('owner').includes('formula:actual:read'));
});

test('Admin rail: every entry opens, except the two listed for the owner to decide', () => {
  const routes = mainRoutes();
  const admin = new Set(grantsOf('admin'));
  const refused = rail('admin').filter(({ path }) => routes.get(path) && !admin.has(routes.get(path)!)).map((e) => e.label);
  // Materials: the role is masked by design. Units: never asked for. Both fail this test if granted, so the list cannot go stale.
  assert.deepEqual(refused, ['Materials', 'Units']);
  assert.ok(admin.has('platform:document_master:write'), 'Documents: Owner or Admin may change them');
  for (const p of ['location:location_master:write', 'platform:contact_master:write', 'platform:country_master:write']) assert.ok(!admin.has(p), `${p} was not asked for`);
});

test('the floor map has no zone of its own', () => {
  const src = read('backend/api/src/dashboard/dashboard.service.ts');
  assert.doesNotMatch(src, /Citrus|Florals|zoneOf|const ZONES/);
});

test('no list column is a raw reference where a human number exists', () => {
  const src = read('web/shell.js');
  for (const ep of ['production-orders', 'material-pick-lists', 'material-issues', 'fg-reservations']) {
    const cols = new RegExp(`'/v1/${ep}': \\[([^\\]]*)\\]`).exec(src)![1]!;
    assert.doesNotMatch(cols, /Id'/, ep);
  }
});

test('printed heading and wording read Raw Aromachem', () => {
  for (const f of ['web/shell.js', 'web/ws-produce.js', 'web/ws-mfg.js', 'web/index.html', 'web-platform/index.html', 'web-vault/index.html', 'web-platform/platform.js', 'web-vault/vault.js']) {
    assert.doesNotMatch(read(f).replace(/^\s*\*.*$/gm, ''), /RAW AROMA CHEM|Raw Aroma Chem/, f);
  }
});

test('the phone keeps the Exit focus mode pill off the top of the screen', () => {
  for (const f of ['web/focus.js', 'web-platform/focus.js', 'web-vault/focus.js']) assert.match(read(f), /@media \(max-width:720px\)\{\.ra-focus-exit\{top:auto;bottom:/, f);
});
