/**
 * SWEEP-VAULT-2/3: Access / Production audit. The screen read the newest 200 mixed audit events,
 * filtered them in the browser to one kind, and headlined the filtered count as the total: a busy
 * floor's picklist reads pushed every human read off the Access audit, which then said "0 rows".
 * The kind is now filtered and counted on the server (formula-directory.service.ts, DB-tested in
 * cluster-formula's formula-directory.test.ts); this file covers the layers above it: the
 * envelope carries the total, both boxes' routes and the signed channel carry the kind, the main
 * box keeps the total, and web-vault/vault.js asks for the kind and headlines the server total.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { firstValueFrom, of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from '@core/backend-kernel';
import { apiMeta } from '@core/contracts';
import { AuditController } from '../audit/audit.controller.js';
import { AuditService } from '../audit/audit.service.js';
import { VaultPortInternalController } from '../vault-bridge/vault-port-internal.controller.js';
import { FormulasController } from '../../../cluster-formula/src/formulas/formulas.controller.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web-vault/vault.js'), 'utf8');
function fn(name: string, ctx: Record<string, unknown>) {
  const s = js.indexOf('function ' + name + '('); assert.ok(s > 0, name);
  const a = js.lastIndexOf('\n', s);
  vm.createContext(ctx); vm.runInContext(js.slice(a, js.indexOf('\n  }\n', s) + 4) + '\nthis.f = ' + name + ';', ctx);
  return ctx.f as (...x: unknown[]) => unknown;
}
const pageItems = (p: unknown) => (Array.isArray(p) ? p : ((p as { items?: unknown[] })?.items ?? []));
const page = { items: [{ action: 'formula.actual.read', actorId: 'u1' }], nextCursor: '1', total: 41 };

test('the envelope lifts a page total into meta.total, beside meta.cursor', async () => {
  const ctx = { switchToHttp: () => ({ getRequest: () => ({ requestId: 'rq' }) }) } as never;
  const env = (await firstValueFrom(new ResponseEnvelopeInterceptor().intercept(ctx, { handle: () => of(page) }))) as { data: unknown; meta: Record<string, unknown> };
  assert.deepEqual(env.data, page.items);
  assert.equal(env.meta.cursor, '1'); assert.equal(env.meta.total, 41);
  assert.equal(apiMeta.parse(env.meta).total, 41, 'the contract carries it');
  const plain = (await firstValueFrom(new ResponseEnvelopeInterceptor().intercept(ctx, { handle: () => of({ items: [], nextCursor: null }) }))) as { meta: Record<string, unknown> };
  assert.equal('total' in plain.meta, false, 'a page without a total gets none');
});

test('the Vault box route passes ?kind= through and refuses an unknown kind', async () => {
  const seen: unknown[] = [];
  const c = new FormulasController(null as never, { accessAudit: async (...a: unknown[]) => { seen.push(a); return page; } } as never);
  await c.accessAudit('100', '200', 'production');
  assert.deepEqual(seen[0], [100, '200', 'production']);
  assert.throws(() => c.accessAudit('100', undefined, 'everything'), /kind/);
});

test('the signed channel accepts a kind and nothing else', async () => {
  const seen: unknown[] = [];
  const c = new VaultPortInternalController(null as never, null as never, null as never, null as never, null as never, null as never);
  (c as unknown as { directory: unknown }).directory = { accessAudit: async (...a: unknown[]) => { seen.push(a); return page; } };
  const { accessAuditBody } = await import('../vault-bridge/vault-port-internal.controller.js');
  assert.deepEqual(accessAuditBody.parse({ limit: 10, cursor: null, kind: 'access' }), { limit: 10, cursor: null, kind: 'access' });
  assert.throws(() => accessAuditBody.parse({ limit: 10, kind: 'all' }));
  assert.deepEqual(await c.accessAudit({ limit: 10, cursor: null, kind: 'access' }), { result: page });
  assert.deepEqual(seen[0], [10, null, 'access']);
});

test('the main box asks the Vault for the kind and keeps its total', async () => {
  const seen: unknown[] = [];
  const sql = (async () => [{ user_id: 'u1', email: 'a@b.c' }]) as never;
  const svc = new AuditService(sql, { accessAudit: async (...a: unknown[]) => { seen.push(a); return page; } } as never);
  const out = await new AuditController(svc).formulaAccess('50', undefined, 'access');
  assert.deepEqual(seen[0], [50, '0', 'access']);
  assert.equal(out.total, 41); assert.equal(out.items[0]!.actor, 'a@b.c');
  assert.throws(() => new AuditController(svc).formulaAccess('50', undefined, 'x'), /kind/);
});

test('the screen asks the server for its kind, pages on the server cursor, and headlines the server total', async () => {
  const asked: string[] = [];
  const f = fn('auditPage', { encodeURIComponent, pageItems, VaultError: Error, vaultTunnel: async (p: string) => { asked.push(p); return { status: 200, json: { data: page.items, meta: { cursor: '100', total: 341 } } }; } });
  const r = (await f('access', null)) as { rows: unknown[]; cursor: string | null; total: number };
  assert.deepEqual(asked, ['/v1/formula-access-audit?limit=100&kind=access']);
  assert.equal(r.total, 341); assert.equal(r.cursor, '100');
  await f('production', '100');
  assert.equal(asked[1], '/v1/formula-access-audit?limit=100&kind=production&cursor=100');
  const g = fn('auditPage', { encodeURIComponent, pageItems, VaultError: class extends Error { constructor(_c: string, m: string) { super(m); } }, vaultTunnel: async () => ({ status: 500, json: { error: { message: 'down' } } }) });
  await assert.rejects(g('access', null) as Promise<unknown>, /down/);
  const t = fn('auditCountText', {});
  assert.equal(t(341, 100), '341 events · 100 shown');
  assert.equal(t(4, 4), '4 events');
  assert.doesNotMatch(js, /HUMAN_PREFIXES|MFG_PREFIXES|auditCollect/, 'the split lives on the server only');
});
