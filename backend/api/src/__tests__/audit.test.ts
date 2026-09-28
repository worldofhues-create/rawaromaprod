/**
 * AuditService.loginHistory (backend/api/src/audit/audit.service.ts) — GET /v1/login-history over
 * iam.login_history (scripts/migrations/2026-09-28-login-history.sql, lane platform-roles): every
 * sign-in attempt, newest first, paged, with display-ready when/who/how/result. Exercised on a
 * Drizzle-wrapped pool, as the running API's PG_CLIENT is. The WRITE side is tested in
 * backend/cluster-org/src/__tests__/login-history.test.ts.
 *
 * formulaAccessAudit (reads formula.audit_events, a real per-schema cross-cutting table built by
 * the @core/data-kernel auditTable() factory) is left untested here: the `formula` schema lives
 * on its own vault connection (scripts/db-schema-groups.ts, vault: true) and is out of this
 * lane's test harness / boundary — see backend/api/src/__tests__/vault-boundary.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { AuditService, signInMethodLabel } from '../audit/audit.service.js';
import { ensureSchema, testClient, closeTestClient, TEST_DATABASE_URL } from '../../../test-support/db.js';

let svc: AuditService;
let wrapped: ReturnType<typeof postgres>;

before(async () => {
  await ensureSchema();
  wrapped = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, types: {}, onnotice: () => {} });
  drizzle(wrapped);
  svc = new AuditService(wrapped as never);
});

after(async () => {
  await wrapped.end({ timeout: 1 });
  await closeTestClient();
});

test('login-history: newest first, with who/how/result in plain words and the account email as fallback', async () => {
  const sql = testClient();
  const userId = crypto.randomUUID();
  const email = `lh-read-${userId.slice(0, 8)}@rawaroma.local`;
  await sql`insert into iam.user_master (user_id, email, user_name, is_active) values (${userId}, ${email}, 'Reader', true)`;
  // Far-future timestamps, later on every run, keep these three at the top of the list whatever
  // else the shared test DB already holds (including earlier runs of this test).
  const base = Date.now() + 500 * 365 * 86_400_000;
  const at = (s: number) => new Date(base + s * 1000).toISOString();
  await sql`insert into iam.login_history (occurred_at, user_id, email, method, console, outcome, ip)
    values (${at(1)}, ${userId}, null, 'ALEMBIC_SSO', 'factory', 'SUCCESS', '198.51.100.1')`;
  await sql`insert into iam.login_history (occurred_at, user_id, email, method, console, outcome, reason_code, reason, ip)
    values (${at(2)}, ${userId}, ${email}, 'VAULT_STEP_UP', 'vault', 'REFUSED', 'AUTH_FORBIDDEN', 'Account inactive', '198.51.100.2')`;
  await sql`insert into iam.login_history (occurred_at, email, method, outcome, reason_code, reason)
    values (${at(3)}, null, 'PASSWORD', 'REFUSED', 'AUTH_FORBIDDEN', 'Password sign-in is retired. Sign in via ALEMBIC.')`;

  const { items } = await svc.loginHistory(3);
  const top = items as unknown as Array<Record<string, string | null>>;
  assert.deepEqual(top.map((r) => r.when), [at(3), at(2), at(1)]);
  assert.deepEqual(top.map((r) => [r.who, r.how, r.result]), [
    ['Unknown', 'Password', 'Refused: Password sign-in is retired. Sign in via ALEMBIC.'],
    [email, 'Vault step-up', 'Refused: Account inactive'],
    [email, 'ALEMBIC SSO · Factory', 'Success'],
  ]);
  assert.equal(top[2]!.email, email, 'no recorded email falls back to the account email');
  assert.equal(top[1]!.ip, '198.51.100.2');
});

test('login-history: pages with an opaque cursor, bounded limit', async () => {
  const first = await svc.loginHistory(2);
  assert.equal(first.items.length, 2);
  assert.equal(first.nextCursor, '2');
  const second = await svc.loginHistory(2, first.nextCursor!);
  const ids = new Set([...first.items, ...second.items].map((r) => r.loginHistoryId));
  assert.equal(ids.size, first.items.length + second.items.length, 'pages never overlap');
  assert.equal((await svc.loginHistory(10_000)).items.length <= 500, true);
  assert.ok((await svc.loginHistory(1, 'garbage')).items.length <= 1);
});

test('signInMethodLabel: the words every console shows under "How"', () => {
  assert.equal(signInMethodLabel('ALEMBIC_SSO', 'platform'), 'ALEMBIC SSO · Platform');
  assert.equal(signInMethodLabel('ALEMBIC_SSO', null), 'ALEMBIC SSO');
  assert.equal(signInMethodLabel('VAULT_STEP_UP', 'vault'), 'Vault step-up');
  assert.equal(signInMethodLabel('PASSWORD', null), 'Password');
});
