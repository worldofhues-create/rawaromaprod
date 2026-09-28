/**
 * Lane platform-roles (2026-09-28) — every sign-in attempt lands in iam.login_history
 * (scripts/migrations/2026-09-28-login-history.sql), from AuthService's two doors:
 *   - the ALEMBIC SSO exchange (POST /auth/alembic-assertion), recorded as ALEMBIC_SSO for the
 *     factory/platform consoles and VAULT_STEP_UP for the Vault console's exchange;
 *   - the retired password door (POST /auth/login), whose refusals are recorded too.
 * Refusals carry the code + sentence the caller was shown. No row ever holds the assertion, an
 * access/refresh token, a token hash, the password, or a typed identifier that isn't an email.
 *
 * The recorder runs on a Drizzle-WRAPPED pool, exactly as the running API's PG_CLIENT is (its
 * parameters are not serialized, so every bound value must already be text).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign as edSign } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { uuidv7 } from '@core/data-kernel';
import { ConfigService, JwtService } from '@core/backend-kernel';
import { AuthService, type SignInContext } from '../auth/auth.service.js';
import { ensureSchema, orgDb, orgSchema, testClient, closeTestClient, TEST_DATABASE_URL } from '../../../test-support/db.js';

const { userMaster } = orgSchema;
let db: ReturnType<typeof orgDb>;
let wrapped: ReturnType<typeof postgres>;

before(async () => {
  await ensureSchema();
  db = orgDb();
  wrapped = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, types: {}, onnotice: () => {} });
  drizzle(wrapped);
});

after(async () => {
  await wrapped.end({ timeout: 1 });
  await closeTestClient();
});

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const { privateKey: otherPrivate } = generateKeyPairSync('ed25519');
const VERIFY_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function signAssertion(claims: Record<string, unknown>, key = privateKey): string {
  const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }), 'utf8').toString('base64url');
  const p = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`, 'utf8'), key).toString('base64url')}`;
}

function claimsFor(email: string, overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: 'alembic', aud: 'rawprod', sub: randomUUID(), tenant_id: 't1', org_id: 't1', email,
    roles: ['admin'], target: 'factory', iat: nowSec, exp: nowSec + 45, jti: randomUUID(),
    auth_time: nowSec - 30, ...overrides,
  };
}

function makeService(overrides: Record<string, string> = {}, sql: unknown = wrapped): AuthService {
  const config = new ConfigService({
    NODE_ENV: 'test', APP_ENV: 'dev', DATABASE_URL: TEST_DATABASE_URL, JWT_SECRET: 'a'.repeat(32),
    ALEMBIC_ASSERTION_VERIFY_KEY: VERIFY_KEY_B64, ...overrides,
  } as NodeJS.ProcessEnv);
  return new AuthService(db, new JwtService(config), sql as never, config);
}

async function makeUser(email: string, isActive = true): Promise<string> {
  const userId = uuidv7();
  await db.insert(userMaster).values({ userId, email, userName: email, isActive, createdBy: 'test', updatedBy: 'test' });
  return userId;
}

/** A per-attempt User-Agent, so each test finds exactly its own rows. */
function ctx(): SignInContext & { userAgent: string } {
  return { ip: '203.0.113.7', userAgent: `lh-test/${randomUUID()}` };
}

interface Row {
  user_id: string | null; email: string | null; method: string; console: string | null; outcome: string;
  reason_code: string | null; reason: string | null; ip: string | null; user_agent: string | null; session_id: string | null;
}
async function rowsFor(userAgent: string): Promise<Row[]> {
  return testClient()<Row[]>`
    select user_id::text, email, method, console, outcome, reason_code, reason, ip, user_agent, session_id::text
      from iam.login_history where user_agent = ${userAgent} order by occurred_at, login_history_id`;
}

function sidOf(accessToken: string): string {
  return JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')).sid;
}

test('ALEMBIC SSO into the factory console: one SUCCESS row — who, how, console, IP, browser, session', async () => {
  const email = `lh-ok-${randomUUID().slice(0, 8)}@rawaroma.local`;
  const userId = await makeUser(email);
  const c = ctx();
  const out = await makeService().loginWithAssertion(signAssertion(claimsFor(email)), c);
  const rows = await rowsFor(c.userAgent);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    user_id: userId, email, method: 'ALEMBIC_SSO', console: 'factory', outcome: 'SUCCESS',
    reason_code: null, reason: null, ip: '203.0.113.7', user_agent: c.userAgent, session_id: sidOf(out.accessToken),
  });
});

test('the Vault console\'s exchange (target vault) is recorded as VAULT_STEP_UP', async () => {
  const email = `lh-vault-${randomUUID().slice(0, 8)}@rawaroma.local`;
  await makeUser(email);
  const c = ctx();
  await makeService().loginWithAssertion(signAssertion(claimsFor(email, { target: 'vault' })), c);
  const [row] = await rowsFor(c.userAgent);
  assert.equal(row!.method, 'VAULT_STEP_UP');
  assert.equal(row!.console, 'vault');
  assert.equal(row!.outcome, 'SUCCESS');
});

test('a REFUSED sign-in is recorded: unknown account — the email it named, the code and the sentence shown', async () => {
  const email = `lh-nobody-${randomUUID().slice(0, 8)}@rawaroma.local`;
  const c = ctx();
  await assert.rejects(() => makeService().loginWithAssertion(signAssertion(claimsFor(email)), c), { code: 'AUTH_UNKNOWN_USER' });
  const [row] = await rowsFor(c.userAgent);
  assert.equal(row!.outcome, 'REFUSED');
  assert.equal(row!.reason_code, 'AUTH_UNKNOWN_USER');
  assert.match(row!.reason!, /No RawProd account is provisioned/);
  assert.equal(row!.email, email);
  assert.equal(row!.user_id, null);
  assert.equal(row!.session_id, null);
});

test('refused: an inactive account is recorded against that account', async () => {
  const email = `lh-off-${randomUUID().slice(0, 8)}@rawaroma.local`;
  const userId = await makeUser(email, false);
  const c = ctx();
  await assert.rejects(() => makeService().loginWithAssertion(signAssertion(claimsFor(email)), c), { code: 'AUTH_FORBIDDEN' });
  const [row] = await rowsFor(c.userAgent);
  assert.equal(row!.outcome, 'REFUSED');
  assert.equal(row!.user_id, userId);
  assert.equal(row!.reason, 'Account inactive');
});

test('refused: a forged assertion names nobody — nothing from an unverified token is recorded', async () => {
  const email = `lh-forged-${randomUUID().slice(0, 8)}@rawaroma.local`;
  await makeUser(email);
  const c = ctx();
  await assert.rejects(
    () => makeService().loginWithAssertion(signAssertion(claimsFor(email, { target: 'vault' }), otherPrivate), c),
    { code: 'AUTH_ASSERTION_INVALID' },
  );
  const [row] = await rowsFor(c.userAgent);
  assert.equal(row!.outcome, 'REFUSED');
  assert.equal(row!.reason_code, 'AUTH_ASSERTION_INVALID');
  assert.equal(row!.email, null);
  assert.equal(row!.user_id, null);
  assert.equal(row!.method, 'ALEMBIC_SSO');
  assert.equal(row!.console, null);
});

test('refused: a replayed assertion is recorded as a second, refused attempt', async () => {
  const email = `lh-replay-${randomUUID().slice(0, 8)}@rawaroma.local`;
  await makeUser(email);
  const c = ctx();
  const token = signAssertion(claimsFor(email));
  const svc = makeService();
  await svc.loginWithAssertion(token, c);
  await assert.rejects(() => svc.loginWithAssertion(token, c), { code: 'AUTH_ASSERTION_REPLAYED' });
  const rows = await rowsFor(c.userAgent);
  assert.deepEqual(rows.map((r) => [r.outcome, r.reason_code]), [['SUCCESS', null], ['REFUSED', 'AUTH_ASSERTION_REPLAYED']]);
});

test('the retired password door records its refusals — never the password, never a non-email identifier', async () => {
  const email = `lh-pw-${randomUUID().slice(0, 8)}@rawaroma.local`;
  const c1 = ctx();
  await assert.rejects(() => makeService({ APP_ENV: 'prod' }).login(email, 'hunter2-secret', c1), { code: 'AUTH_FORBIDDEN' });
  const [retired] = await rowsFor(c1.userAgent);
  assert.equal(retired!.method, 'PASSWORD');
  assert.equal(retired!.outcome, 'REFUSED');
  assert.equal(retired!.email, email);
  assert.match(retired!.reason!, /retired/);

  // Someone typed their password into the email box: the attempt is logged, the text is not.
  const c2 = ctx();
  await assert.rejects(() => makeService({ PASSWORD_LOGIN_ENABLED: 'true' }).login('Tr0ub4dor&3', 'x', c2), { code: 'AUTH_INVALID_CREDENTIALS' });
  const [typed] = await rowsFor(c2.userAgent);
  assert.equal(typed!.outcome, 'REFUSED');
  assert.equal(typed!.email, null);
});

test('no secrets or tokens in any row, and no column that could hold one', async () => {
  const email = `lh-secret-${randomUUID().slice(0, 8)}@rawaroma.local`;
  await makeUser(email);
  const c = ctx();
  const assertion = signAssertion(claimsFor(email));
  const out = await makeService().loginWithAssertion(assertion, c);
  await assert.rejects(() => makeService().loginWithAssertion(assertion, c));
  const c2 = ctx();
  await assert.rejects(() => makeService({ APP_ENV: 'prod' }).login(email, 'hunter2-secret', c2));

  const cols = await testClient()<{ column_name: string }[]>`
    select column_name from information_schema.columns where table_schema = 'iam' and table_name = 'login_history'`;
  for (const { column_name } of cols) assert.doesNotMatch(column_name, /token|hash|password|secret|jti|assertion/i);

  const all = [...await rowsFor(c.userAgent), ...await rowsFor(c2.userAgent)];
  assert.equal(all.length, 3);
  const secrets = [assertion, ...assertion.split('.'), out.accessToken, out.refreshToken, 'hunter2-secret'];
  for (const r of all) {
    const text = JSON.stringify(r);
    for (const s of secrets) assert.equal(text.includes(s), false, 'a login_history row must not contain a token or password');
  }
});

test('a failed history write never blocks or changes a sign-in', async () => {
  const email = `lh-down-${randomUUID().slice(0, 8)}@rawaroma.local`;
  await makeUser(email);
  const broken = () => Promise.reject(new Error('database unavailable'));
  const out = await makeService({}, broken).loginWithAssertion(signAssertion(claimsFor(email)), ctx());
  assert.ok(out.accessToken);
  await assert.rejects(
    () => makeService({}, broken).loginWithAssertion(signAssertion(claimsFor(`lh-nobody2-${randomUUID()}@x.local`)), ctx()),
    { code: 'AUTH_UNKNOWN_USER' },
  );
});

test('iam.login_history is append-only — UPDATE, DELETE and TRUNCATE are refused', async () => {
  const email = `lh-ro-${randomUUID().slice(0, 8)}@rawaroma.local`;
  await makeUser(email);
  const c = ctx();
  await makeService().loginWithAssertion(signAssertion(claimsFor(email)), c);
  const sql = testClient();
  await assert.rejects(() => sql`update iam.login_history set outcome = 'REFUSED' where user_agent = ${c.userAgent}`, /append-only/);
  await assert.rejects(() => sql`delete from iam.login_history where user_agent = ${c.userAgent}`, /append-only/);
  await assert.rejects(() => sql`truncate iam.login_history`, /append-only/);
  assert.equal((await rowsFor(c.userAgent)).length, 1);
});
