/**
 * SWEEP2-R1: a retried write lands once. Real Postgres (TEST_DATABASE_URL; the browser suite's
 * private PostGIS on 5544 in the sweep), the real migration file, the real interceptor, and a handler
 * that writes a row per run -- so "landed once" is a count of rows, not a mock's call count.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { lastValueFrom, Observable } from 'rxjs';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const URL_ = process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : 'TEST_DATABASE_URL unset: the idempotency store is NOT being checked';
let sql: Sql;
const USER = '0190a8e2-0000-7000-8000-000000000001';
const OTHER = '0190a8e2-0000-7000-8000-000000000002';

before(async () => {
  if (!URL_) return;
  sql = postgres(URL_, { max: 4, onnotice: () => {} });
  await sql`create schema if not exists platform`;
  await sql`drop table if exists platform.idempotency_key`;
  const mig = readFileSync(join(root, 'scripts/migrations/2026-11-03-idempotency-key.sql'), 'utf8');
  await sql.unsafe(mig.slice(mig.indexOf('-- @target: main') + '-- @target: main'.length));
  await sql`create table if not exists public.sweep2_writes (n serial primary key, body text)`;
  await sql`truncate public.sweep2_writes`;
});
after(async () => { if (sql) { await sql`drop table if exists public.sweep2_writes`; await sql.end(); } });

function ctx(userId: string, key: string | undefined, body: unknown, method = 'POST', url = '/v1/stock-adjustments') {
  const req = { method, url, body, headers: key ? { 'idempotency-key': key } : {}, user: { userId } };
  return { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as never;
}
const writeOnce = (body: string, delay = 0, fail = false) => ({
  handle: () => new Observable((s) => {
    setTimeout(async () => {
      try {
        if (fail) throw new Error('refused');
        const [r] = await sql`insert into public.sweep2_writes (body) values (${body}) returning n`;
        s.next({ adjustmentId: r!.n, body }); s.complete();
      } catch (e) { s.error(e); }
    }, delay);
  }),
});
const count = async () => Number((await sql`select count(*)::int as c from public.sweep2_writes`)[0]!.c);
const run = (i: IdempotencyInterceptor, c: never, h: ReturnType<typeof writeOnce>) => lastValueFrom(i.intercept(c, h as never));

test('a retried write with the same key lands once and both get the same answer', { skip }, async () => {
  const i = new IdempotencyInterceptor(sql);
  await sql`truncate public.sweep2_writes`;
  const a = await run(i, ctx(USER, 'key-retry-0001', { qty: 2 }), writeOnce('qty 2'));
  const b = await run(i, ctx(USER, 'key-retry-0001', { qty: 2 }), writeOnce('qty 2'));
  assert.equal(await count(), 1);
  assert.deepEqual(b, a);
});

test('a re-send while the first is still running is told to wait, and still lands once', { skip }, async () => {
  const i = new IdempotencyInterceptor(sql);
  await sql`truncate public.sweep2_writes`;
  const first = run(i, ctx(USER, 'key-busy-0001', { qty: 3 }), writeOnce('qty 3', 80));
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(run(i, ctx(USER, 'key-busy-0001', { qty: 3 }), writeOnce('qty 3')), (e: { status?: number }) => e.status === 409);
  await first;
  assert.equal(await count(), 1);
});

test('the same key for a different request is refused; another user may use the same key', { skip }, async () => {
  const i = new IdempotencyInterceptor(sql);
  await sql`truncate public.sweep2_writes`;
  await run(i, ctx(USER, 'key-shape-0001', { qty: 4 }), writeOnce('qty 4'));
  await assert.rejects(run(i, ctx(USER, 'key-shape-0001', { qty: 5 }), writeOnce('qty 5')), (e: { status?: number }) => e.status === 422);
  await run(i, ctx(OTHER, 'key-shape-0001', { qty: 4 }), writeOnce('qty 4, other'));
  assert.equal(await count(), 2);
});

test('a write that failed releases its key, so the retry runs', { skip }, async () => {
  const i = new IdempotencyInterceptor(sql);
  await sql`truncate public.sweep2_writes`;
  await assert.rejects(run(i, ctx(USER, 'key-fail-0001', { qty: 6 }), writeOnce('qty 6', 0, true)));
  await run(i, ctx(USER, 'key-fail-0001', { qty: 6 }), writeOnce('qty 6'));
  assert.equal(await count(), 1);
});

test('no key, or a GET, passes through as before', { skip }, async () => {
  const i = new IdempotencyInterceptor(sql);
  await sql`truncate public.sweep2_writes`;
  await run(i, ctx(USER, undefined, { qty: 7 }), writeOnce('a'));
  await run(i, ctx(USER, undefined, { qty: 7 }), writeOnce('b'));
  assert.equal(await count(), 2);
});

test('the tunnel forwards the key, the console sends one per intent, and the migration has a rollback', () => {
  const ctl = readFileSync(join(root, 'backend/api/src/crypto/crypto.controller.ts'), 'utf8');
  assert.match(ctl, /'idempotency-key': req\.idempotencyKey/);
  const app = readFileSync(join(root, 'backend/api/src/app.module.ts'), 'utf8');
  assert.ok(app.indexOf('useClass: IdempotencyInterceptor') > app.indexOf('useClass: ResponseEnvelopeInterceptor'), 'inside the envelope');
  assert.ok(app.indexOf('useClass: IdempotencyInterceptor') < app.indexOf('useClass: WriteAuditInterceptor'), 'outside the audit: a replay is not a second write');
  for (const f of ['web/shell.js', 'web-platform/platform.js']) {
    const js = readFileSync(join(root, f), 'utf8');
    assert.match(js, /idempotencyKey = opts\.idemKey/, f);
    assert.match(js, /idemKey: key/, f);
  }
  const down = readFileSync(join(root, 'scripts/migrations/rollback/2026-11-03-idempotency-key.down.sql'), 'utf8');
  assert.match(down, /drop table if exists platform\.idempotency_key/);
});
