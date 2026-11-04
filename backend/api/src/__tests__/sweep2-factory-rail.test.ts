/**
 * SWEEP2-FACTORY-1: every rail item, for every role, opens a list the role may read. The Factory
 * Admin rail drew Materials and Units (masterdata:material:read, platform:uom_master:read, neither
 * granted to `admin`) and the Owner rail, which the showcase also opens, drew Users, Write audit
 * trail and Approval matrix, which the showcase may not read -- each a 403 behind a live link. An item
 * a role cannot read must be named in shell.js NAV_READ with its route's own permission, so the
 * rail drops it once the session's permissions are known. Reads real grants and real @Permissions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../../../../scripts/ra-roles.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shell = readFileSync(join(root, 'web/shell.js'), 'utf8');
const ctrl: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d)) {
    if (['node_modules', 'dist', '__tests__'].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p); else if (e.endsWith('.controller.ts')) ctrl.push(readFileSync(p, 'utf8'));
  }
})(join(root, 'backend'));
function perm(ep: string): string | null {
  const esc = ep.replace(/[-/]/g, (c) => '\\' + c);
  const re = new RegExp(`@Get\\('(?:v1/)?${esc}'\\)[\\s\\S]{0,300}?@Permissions\\('([^']+)'\\)|@Permissions\\('([^']+)'\\)[\\s\\S]{0,200}?@Get\\('(?:v1/)?${esc}'\\)`);
  for (const c of ctrl) { const h = re.exec(c); if (h) return (h[1] ?? h[2]) as string; }
  return null;
}
const navRead: Record<string, string> = {};
const nr = /var NAV_READ = \{([^}]*)\}/.exec(shell);
for (const m of (nr && nr[1] ? nr[1] : '').matchAll(/'(\/v1\/[^']+)':\s*'([^']+)'/g)) navRead[m[1]!] = m[2]!;

test('every rail item is readable by its role, or dropped for it by NAV_READ', () => {
  const block = shell.slice(shell.indexOf('  var ROLES = {'), shell.indexOf('Object.keys(ROLES).forEach'));
  const marks = [...block.matchAll(/\n    ([a-z]+): \{ label: '/g)].map((m) => [m[1]!, m.index!] as const);
  const refused: string[] = [];
  marks.forEach(([key, at], i) => {
    const seg = block.slice(at, i + 1 < marks.length ? marks[i + 1]![1] : block.length);
    const codes = key === 'superadmin' ? ['owner', 'showcase'] : [key];
    for (const t of seg.matchAll(/\['[a-z0-9]+', '([^']+)', '[a-zA-Z]+', '(\/v1\/[^']+)'/g)) {
      const ep = t[2]!; const p = perm(ep.slice(4));
      assert.ok(p, `${key} ${t[1]}: ${ep} has a list route with @Permissions`);
      for (const code of codes) {
        const role = ROLES.find((r) => r.code === code);
        assert.ok(role, code);
        if (role.select(p!)) continue;
        if (navRead[ep] === p) continue;
        refused.push(`${code}: ${t[1]} (${ep}, ${p})`);
      }
    }
  });
  assert.deepEqual(refused, [], 'rail links that lead to a refusal');
});

test('the rail is pruned once the permissions arrive, before the address is opened', () => {
  // WALK-RP-17: pruned only when /me answered; a failed /me keeps the rail and says so.
  assert.match(shell, /session\.perms = me\.permissions; return true; \} return false; \}, function \(\) \{ return false; \}\)\.then\(function \(ok\) \{ if \(ok\) pruneNav\(\); else toast\([^;]+\); landOnAddress\(\);/);
  assert.match(shell, /function pruneNav\(\)/);
});
