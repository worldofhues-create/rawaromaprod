/**
 * SWEEP-VAULT: Access / Production audit (web-vault/vault.js; no browser). The screen read the
 * newest 200 audit events, filtered them in the browser to one kind, and headlined the filtered
 * count as the total: a busy floor's picklist reads pushed every human read off the Access audit,
 * which then said "0 rows". auditCollect reads pages until it has a screenful of the kind or the
 * log ends; the count is a total only when the log was read to the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web-vault/vault.js'), 'utf8');
function fn(name: string, ctx: Record<string, unknown>) {
  const s = js.indexOf('function ' + name + '('); assert.ok(s > 0, name);
  const a = js.lastIndexOf('\n', s);
  vm.createContext(ctx); vm.runInContext(js.slice(a, js.indexOf('\n  }\n', s) + 4) + '\nthis.f = ' + name + ';', ctx);
  return ctx.f as (...x: unknown[]) => unknown;
}

const ev = (action: string) => ({ action });
test('reads past pages of other events to find this kind, and stops at the end of the log', async () => {
  const pages: Record<string, unknown> = {
    '/v1/formula-access-audit?limit=500': { data: Array.from({ length: 3 }, () => ev('formula.picklist.read')), meta: { cursor: '500' } },
    '/v1/formula-access-audit?limit=500&cursor=500': { data: [ev('formula.actual.read')], meta: { cursor: null } },
  };
  const f = fn('auditCollect', { encodeURIComponent, VaultError: Error, vaultTunnel: async (p: string) => ({ status: 200, json: pages[p] }) });
  const r = (await f(['formula.actual.read'], null)) as { rows: unknown[]; cursor: string | null };
  assert.equal(r.rows.length, 1); assert.equal(r.cursor, null);
});

test('a refused page throws instead of a short list', async () => {
  const f = fn('auditCollect', { encodeURIComponent, VaultError: class extends Error { constructor(_c: string, m: string) { super(m); } }, vaultTunnel: async () => ({ status: 500, json: { error: { message: 'down' } } }) });
  await assert.rejects(f(['x'], null) as Promise<unknown>, /down/);
});

test('the count is a total only when the whole log was read', () => {
  const f = fn('auditCountText', {});
  assert.equal(f(4, null), '4 events');
  assert.match(String(f(100, '500')), /^100 shown, older events not read yet$/);
  assert.match(js, /auditCountText\(/); assert.doesNotMatch(js, /formula-access-audit\?limit=200/);
});
