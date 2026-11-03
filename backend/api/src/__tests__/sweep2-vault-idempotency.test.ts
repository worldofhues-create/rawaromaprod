/**
 * SWEEP2-R1 (Vault): the Vault API honours the Idempotency-Key the Vault console sends, on its own
 * database. Real Postgres (FORMULA_TEST_DATABASE_URL, else TEST_DATABASE_URL; the private PostGIS on
 * 5544 in the sweep), the real formula migration, the real interceptor, a handler that writes a row.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { lastValueFrom, Observable } from 'rxjs';
import { VaultIdempotencyInterceptor } from '../idempotency/vault-idempotency.interceptor.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const URL_ = process.env.FORMULA_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : 'no test database: the Vault idempotency store is NOT being checked';
let sql: Sql;
const USER = '0190a8e2-0000-7000-8000-0000000000aa';

before(async () => {
  if (!URL_) return;
  sql = postgres(URL_, { max: 4, onnotice: () => {} });
  await sql`create schema if not exists formula`;
  await sql`drop table if exists formula.idempotency_key`;
  const mig = readFileSync(join(root, 'scripts/migrations/2026-11-03-vault-idempotency-key.sql'), 'utf8');
  await sql.unsafe(mig.slice(mig.indexOf('-- @target: formula') + '-- @target: formula'.length));
  await sql`create table if not exists public.sweep2_vault_writes (n serial primary key)`;
  await sql`truncate public.sweep2_vault_writes`;
});
after(async () => { if (sql) { await sql`drop table if exists public.sweep2_vault_writes`; await sql.end(); } });

const ctx = (key: string, body: unknown) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => (
  { method: 'POST', url: '/v1/formula-access-policies', body, headers: { 'idempotency-key': key }, user: { userId: USER } }) }) }) as never;
const handler = { handle: () => new Observable((s) => { void sql`insert into public.sweep2_vault_writes default values returning n`
  .then(([r]) => { s.next({ formulaAccessPolicyId: r!.n }); s.complete(); }, (e) => s.error(e)); }) };

test('a re-sent Vault write with the same key lands once and both get the same answer', { skip }, async () => {
  const i = new VaultIdempotencyInterceptor(sql);
  const a = await lastValueFrom(i.intercept(ctx('vault-key-0001', { formulaId: 'F1', userId: 'U2' }), handler as never));
  const b = await lastValueFrom(i.intercept(ctx('vault-key-0001', { formulaId: 'F1', userId: 'U2' }), handler as never));
  assert.deepEqual(b, a);
  assert.equal(Number((await sql`select count(*)::int c from public.sweep2_vault_writes`)[0]!.c), 1);
  assert.equal(Number((await sql`select count(*)::int c from formula.idempotency_key where state = 'completed'`)[0]!.c), 1);
  await assert.rejects(lastValueFrom(i.intercept(ctx('vault-key-0001', { formulaId: 'F2' }), handler as never)), (e: { status?: number }) => e.status === 422);
});

test('the Vault API registers it inside the envelope, its store is formula.*, and the migration rolls back', () => {
  const mod = readFileSync(join(root, 'backend/api/src/vault-app.module.ts'), 'utf8');
  assert.ok(mod.indexOf('useClass: VaultIdempotencyInterceptor') > mod.indexOf('useClass: ResponseEnvelopeInterceptor'));
  const src = readFileSync(join(root, 'backend/api/src/idempotency/vault-idempotency.interceptor.ts'), 'utf8');
  assert.match(src, /@Inject\(FORMULA_PG_CLIENT\)[^\n]*'formula\.idempotency_key'/);
  const main = readFileSync(join(root, 'backend/api/src/idempotency/idempotency.interceptor.ts'), 'utf8');
  assert.doesNotMatch(main, /cluster-formula|FORMULA_PG_CLIENT/, 'the main box never names the formula database');
  assert.match(readFileSync(join(root, 'scripts/migrations/rollback/2026-11-03-vault-idempotency-key.down.sql'), 'utf8'), /drop table if exists formula\.idempotency_key/);
  assert.match(readFileSync(join(root, 'web-vault/vault.js'), 'utf8'), /payload\.idempotencyKey = opts\.idemKey/);
});

test('the migration grants the Vault app role explicitly, as the main one does', { skip }, async () => {
  await sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'sweep2_vault_app') then create role sweep2_vault_app; end if; end $$`;
  const mig = readFileSync(join(root, 'scripts/migrations/2026-11-03-vault-idempotency-key.sql'), 'utf8');
  const body = mig.slice(mig.indexOf('-- @target: formula') + '-- @target: formula'.length);
  for (let n = 0; n < 2; n++) { // idempotent: a second run changes nothing and does not fail
    await sql.begin(async (tx) => { await tx`select set_config('rawprod.app_role', 'sweep2_vault_app', true)`; await tx.unsafe(body); });
  }
  const [g] = await sql`select has_table_privilege('sweep2_vault_app', 'formula.idempotency_key', 'select, insert, update, delete') as ok`;
  assert.equal(g!.ok, true);
});
