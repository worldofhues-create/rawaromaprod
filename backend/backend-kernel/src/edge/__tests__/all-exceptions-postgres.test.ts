/**
 * Golden journey lane/j2 — Postgres refusals that are the caller's to fix are not 500s.
 * 23505 unique_violation -> 409 naming the constraint (never the values); 22P02
 * invalid_text_representation (a non-uuid id) -> 400; any other database error stays a 500.
 * Exercised against the REAL postgres.js error shape (a live query on the test database).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { AllExceptionsFilter, postgresErrorOf } from '../all-exceptions.filter.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/rawprod_test';
const sql = postgres(url, { max: 1, onnotice: () => {} });
after(async () => { await sql.end(); });

function run(exception: unknown) {
  const sent: { status?: number; body?: { error: { code: string; message: string } } } = {};
  const reply = { status(c: number) { sent.status = c; return reply; }, send(b: unknown) { sent.body = b as never; return b; } };
  const host = { switchToHttp: () => ({ getRequest: () => ({ requestId: 'r1', method: 'POST', url: '/x' }), getResponse: () => reply }) };
  new AllExceptionsFilter().catch(exception, host as never);
  return sent;
}

async function pgError(q: () => Promise<unknown>): Promise<unknown> {
  try { await q(); } catch (e) { return e; }
  throw new Error('expected the query to fail');
}

test('unique violation -> 409 CONFLICT naming the constraint, not the value', async () => {
  const e = await pgError(async () => {
    await sql`create temp table j2_u (k text constraint j2_u_k_uq unique)`;
    await sql`insert into j2_u values ('secret-value'), ('secret-value')`;
  });
  assert.equal(postgresErrorOf(e)?.code, '23505');
  const out = run(e);
  assert.equal(out.status, 409);
  assert.equal(out.body!.error.code, 'CONFLICT');
  assert.match(out.body!.error.message, /j2_u_k_uq/);
  assert.doesNotMatch(out.body!.error.message, /secret-value/);
});

test('a non-uuid id -> 400, not 500', async () => {
  const e = await pgError(() => sql`select ${'undefined'}::uuid`);
  const out = run(e);
  assert.equal(out.status, 400);
});

test('any other database error is still a 500', async () => {
  const e = await pgError(() => sql`select * from no_such_table_j2`);
  assert.equal(run(e).status, 500);
  assert.equal(run(new Error('plain')).status, 500);
});
