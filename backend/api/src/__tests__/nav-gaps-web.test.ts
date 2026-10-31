/* Owner rail, staff wording, held-back buttons, Vault notices: pins for the things that are silent
 * when broken. The Owner rail check reads the real role grants and each route's real @Permissions,
 * so a rail link can never lead to a refusal without this failing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from '../../../../scripts/ra-roles.js';

const root = new URL('../../../../', import.meta.url).pathname;
const read = (f: string) => readFileSync(join(root, f), 'utf8');

function controllers(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) controllers(p, out);
    else if (e.endsWith('.controller.ts')) out.push(readFileSync(p, 'utf8'));
  }
  return out;
}

test('Owner rail: every added screen is there, and its list route is one owner and showcase may read', () => {
  const shell = read('web/shell.js');
  const owner = shell.slice(shell.indexOf('superadmin: { label'), shell.indexOf('\n    admin: { label'));
  const eps = ['stock-requirements', 'reorder-suggestions', 'purchase-requests', 'rfqs', 'quotations', 'quotation-items', 'vendor-negotiations',
    'purchase-orders', 'po-advance-payments', 'vendors', 'vendor-contacts', 'vendor-rm-mappings', 'vendor-rate-history', 'vendor-performance',
    'vendor-credit-notes', 'qc-rejected-grns', 'vendor-ledger', 'vendor-dispatches', 'gate-entries', 'grns', 'grn-items', 'rm-batches',
    'grn-containers', 'qc-inspections'];
  const src = controllers(join(root, 'backend'));
  const role = (c: string) => ROLES.find((r) => r.code === c)!;
  for (const ep of eps) {
    assert.ok(owner.includes(`'/v1/${ep}'`), `${ep} is on the Owner rail`);
    const re = new RegExp(`@Permissions\\('([^']+)'\\)\\s*@Get\\('(?:v1/)?${ep}'\\)|@Get\\('(?:v1/)?${ep}'\\)\\s*@Permissions\\('([^']+)'\\)`);
    const hit = src.map((s) => re.exec(s)).find(Boolean);
    assert.ok(hit, `${ep}: list route found`);
    const perm = hit![1] ?? hit![2]!;
    assert.ok(role('owner').select(perm), `owner holds ${perm}`);
    assert.ok(role('showcase').select(perm), `showcase holds ${perm}`);
  }
});

test('staff wording: the display text changed, the identifiers did not', () => {
  for (const f of ['web/shell.js', 'web-platform/platform.js', 'web-vault/vault.js']) {
    const js = read(f);
    assert.ok(js.includes('Raw Aromachem sign-in'), f);
    assert.doesNotMatch(js, /Sign in via ALEMBIC [^*]*['<]|'Sign in via ALEMBIC/, f);
    assert.match(js, /Ask Ruh/, f);
    assert.match(js, /ALEMBIC_CONSOLE_URL/, `${f}: the config name stays`);
  }
  assert.match(read('web/screen-guide.js'), /'\/v1\/bridge\/requirements': 'Sales requirements'/);
  assert.match(read('web-platform/platform.js'), /\{ id: 'bridge', label: 'Sales system link'/);
  assert.match(read('web/routes.js'), /'\/v1\/bridge\/requirements': 'alembic-orders'/, 'old addresses keep working');
});

test('Platform: replay and discard use the existing routes, only for platform:flag:write; discard needs a reason', () => {
  const js = read('web-platform/platform.js');
  assert.match(js, /if \(hasPerm\('platform:flag:write'\)\) content\.appendChild\(await heldBackCard\(\)\)/);
  assert.match(js, /api\('\/v1\/bridge\/outbox\/parked'\)/);
  assert.match(js, /'\/v1\/bridge\/outbox\/' \+ encodeURIComponent\(it\.id\) \+ '\/' \+ action/);
  assert.match(js, /if \(discard && !why\) \{ err\.textContent/);
  const c = read('backend/api/src/bridge/bridge.controller.ts');
  for (const a of ['replay', 'discard']) assert.match(c, new RegExp(`@Permissions\\('platform:flag:write'\\)\\s*@Post\\('v1/bridge/outbox/:id/${a}'\\)`));
});

test('Vault: a reload still ends the session; it warns first and says so after, with nothing in storage', () => {
  const js = read('web-vault/vault.js');
  assert.match(js, /addEventListener\('beforeunload', function \(e\) \{\s*if \(session\.token && !leavingForSignIn\)/);
  assert.match(js, /Your session ended for security; sign in again\./);
  assert.doesNotMatch(js, /persist\s*=\s*true|localStorage\.setItem|sessionStorage\.setItem/);
  assert.match(js, /leavingForSignIn = !!ALEMBIC_CONSOLE_URL;\s*if \(ALEMBIC_CONSOLE_URL\) location\.assign/, 'the step-up exit is not stopped by the warning');
});

test('Factory: Open Vault only for an ALEMBIC admin the Vault accepts; anyone else is told an admin must grant access', () => {
  const js = read('web/shell.js');
  assert.match(js, /var can = alembicRoles\.indexOf\('admin'\) >= 0 && .*indexOf\('formula:'\) === 0/);
  assert.match(js, /An admin must grant you access to open the Vault\./);
  assert.match(js, /r === 'formulator' \|\| r === 'vault_approver'.*showVaultOnly\(\)/);
});
