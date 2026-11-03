/**
 * SWEEP-VAULT: Vault list screens read past the first page (web-vault/vault.js; no browser).
 * `api()` returns only `data` and drops `meta.cursor`, so every list stopped at 100 rows. The
 * formula screen filtered the newest 100 versions of ALL formulas down to one formula, so an older
 * formula showed "No versions yet" and "New version" proposed v1 again; its access grants said
 * "Only the owner can read this formula" with grants on file. `apiAll` follows the cursor; this
 * runs that function's own source in a sandbox against a fake channel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web-vault/vault.js'), 'utf8');

function loadApiAll(pages: Record<string, { data: unknown[]; meta?: { cursor?: string | null } }>, calls: string[]) {
  const start = js.indexOf('async function apiAll(');
  assert.ok(start > 0, 'vault.js defines apiAll');
  const end = js.indexOf('\n  }\n', start) + 4;
  const ctx: Record<string, unknown> = {
    vaultTunnel: async (path: string) => { calls.push(path); const p = pages[path]; return p ? { status: 200, json: p } : { status: 500, json: { error: { message: 'boom' } } }; },
    VaultError: class extends Error { constructor(_c: string, m: string) { super(m); } },
  };
  vm.createContext(ctx);
  vm.runInContext(js.slice(start, end) + '\nthis.apiAll = apiAll;', ctx);
  return ctx.apiAll as (path: string) => Promise<unknown[]>;
}

test('apiAll follows meta.cursor until the last page', async () => {
  const calls: string[] = [];
  const apiAll = loadApiAll({
    '/v1/formula-versions?limit=100': { data: [1, 2], meta: { cursor: 'c1' } },
    '/v1/formula-versions?limit=100&cursor=c1': { data: [3], meta: { cursor: null } },
  }, calls);
  assert.deepEqual(JSON.parse(JSON.stringify(await apiAll('/v1/formula-versions?limit=100'))), [1, 2, 3]);
  assert.equal(calls.length, 2);
});

test('apiAll surfaces a failed later page instead of returning a short list', async () => {
  const apiAll = loadApiAll({ '/v1/formulas?limit=100': { data: [1], meta: { cursor: 'x' } } }, []);
  await assert.rejects(apiAll('/v1/formulas?limit=100'), /boom/);
});

test('formula versions, grants, formulas list and certificates read every page', () => {
  for (const p of ["apiAll('/v1/formula-versions?limit=100')", "apiAll('/v1/formula-access-policies?limit=100')"]) assert.ok(js.includes(p), p);
  assert.equal((js.match(/apiAll\('\/v1\/formulas\?limit=100'\)/g) || []).length, 2, 'formulas list + certificates');
  assert.doesNotMatch(js, /await api\('\/v1\/(formulas|formula-versions|formula-access-policies)\?limit=100'\)/);
});
