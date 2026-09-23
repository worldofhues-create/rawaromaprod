/**
 * PB-04 / SB-02 — AuthService.loginWithAssertion (the one-login identity bridge's minting
 * half) and the retirement of password sign-in. Real Postgres, same pattern
 * security-service.test.ts already uses (backend/test-support/db.ts) — `rolesFor`/
 * `permissionsFor` are real Drizzle joins over iam.user_master / role_master /
 * permission_master / role_permission_mapping / user_role_mapping and a fake db would not
 * prove the mapping is actually wired.
 *
 *   TEST_DATABASE_URL=postgres://apple@localhost:5432/rawprod_id_test (lane L-ID's own
 *   throwaway database — never shared with another lane's test DB).
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import { ConfigService, JwtService } from '@core/backend-kernel';
import { AuthService } from '../auth/auth.service.js';
import { ensureSchema, orgDb, orgSchema, testClient, closeTestClient, principal } from '../../../test-support/db.js';

const { userMaster, roleMaster, permissionMaster, rolePermissionMapping, userRoleMapping } = orgSchema;

let db: ReturnType<typeof orgDb>;

before(async () => {
  await ensureSchema();
  db = orgDb();
});

afterAll(async () => {
  await closeTestClient();
});

const sid = () => randomUUID().slice(0, 8);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const { privateKey: otherPrivate } = generateKeyPairSync('ed25519');
const VERIFY_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function b64url(b: Buffer): string {
  return b.toString('base64url');
}

/** Sign an ALEMBIC-shaped assertion, the same wire format
 * `apps/api/src/auth/rawprod-assertion.ts` produces in the ALEMBIC repository. */
function signAssertion(claims: Record<string, unknown>, key = privateKey): string {
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = edSign(null, Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), key);
  return `${headerB64}.${payloadB64}.${b64url(sig)}`;
}

function claimsFor(email: string, overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: 'alembic', aud: 'rawprod', sub: `staff:${email}`,
    tenant_id: 't1', org_id: 't1', email, roles: ['admin'], target: 'factory',
    iat: nowSec, exp: nowSec + 45, jti: randomUUID(),
    auth_time: nowSec - 30,
    ...overrides,
  };
}

/** A ConfigService NOT built through Nest DI — same shortcut
 * security-service.test.ts's direct `new SecurityService(...)` takes, and the pattern
 * ConfigService's own constructor is written for (`source: NodeJS.ProcessEnv = process.env`). */
function testConfig(overrides: Record<string, string> = {}): ConfigService {
  return new ConfigService({
    NODE_ENV: 'test',
    APP_ENV: 'dev',
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_id_test',
    JWT_SECRET: 'a'.repeat(32),
    ALEMBIC_ASSERTION_VERIFY_KEY: VERIFY_KEY_B64,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function makeService(configOverrides: Record<string, string> = {}): AuthService {
  const config = testConfig(configOverrides);
  const jwt = new JwtService(config);
  return new AuthService(db, jwt, testClient(), config);
}

async function makeActiveUser(opts: {
  readonly email: string; readonly isActive?: boolean;
  readonly roleCode?: string; readonly permissionCode?: string;
}): Promise<string> {
  const userId = uuidv7();
  await db.insert(userMaster).values({
    userId, email: opts.email, userName: opts.email,
    isActive: opts.isActive ?? true, createdBy: 'test', updatedBy: 'test',
  });
  if (opts.roleCode) {
    const roleId = uuidv7();
    await db.insert(roleMaster).values({
      roleId, roleCode: opts.roleCode, roleName: opts.roleCode,
      status: 'ACTIVE', createdBy: 'test', updatedBy: 'test',
    });
    await db.insert(userRoleMapping).values({
      userRoleMappingId: uuidv7(), userId, roleId, status: 'ACTIVE',
      createdBy: 'test', updatedBy: 'test',
    });
    if (opts.permissionCode) {
      const permissionId = uuidv7();
      await db.insert(permissionMaster).values({
        permissionId, permissionCode: opts.permissionCode, permissionName: opts.permissionCode,
        status: 'ACTIVE', createdBy: 'test', updatedBy: 'test',
      });
      await db.insert(rolePermissionMapping).values({
        roleId, permissionId, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test',
      } as never);
    }
  }
  return userId;
}

test('valid assertion for a provisioned, active user mints a session with that '
  + "user's REAL roles/permissions (not the assertion's roles claim)", async () => {
  const email = `admin-${sid()}@rawaroma.local`;
  const roleCode = `role-${sid()}`;
  const permCode = `perm-${sid()}`;
  await makeActiveUser({ email, roleCode, permissionCode: permCode });

  const svc = makeService();
  const token = signAssertion(claimsFor(email, { roles: ['some-unrelated-alembic-role'] }));
  const result = await svc.loginWithAssertion(token);

  assert.equal(result.user.email, email);
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);

  // The MINTED token's roles/perms come from user_master's OWN grants, never from the
  // assertion's `roles` claim (which named an unrelated ALEMBIC role above).
  const config = testConfig();
  const jwt = new JwtService(config);
  const claims = await jwt.verifyAccess(result.accessToken);
  assert.ok(claims.roles.includes(roleCode));
  assert.ok(claims.perms.includes(permCode));
});

test('UNKNOWN USER — no auto-provisioning; refused with a clear message', async () => {
  const svc = makeService();
  const email = `nobody-${sid()}@rawaroma.local`;
  const token = signAssertion(claimsFor(email));
  await assert.rejects(
    () => svc.loginWithAssertion(token),
    (err: any) => {
      assert.equal(err.code, 'AUTH_UNKNOWN_USER');
      assert.match(err.message, new RegExp(email));
      return true;
    },
  );
});

test('SUSPENDED USER — isActive=false is refused', async () => {
  const email = `suspended-${sid()}@rawaroma.local`;
  await makeActiveUser({ email, isActive: false });
  const svc = makeService();
  const token = signAssertion(claimsFor(email));
  await assert.rejects(
    () => svc.loginWithAssertion(token),
    (err: any) => {
      assert.equal(err.code, 'AUTH_FORBIDDEN');
      return true;
    },
  );
});

test('REPLAYED JTI — the same assertion presented twice is refused the second time', async () => {
  const email = `replay-${sid()}@rawaroma.local`;
  await makeActiveUser({ email, roleCode: `role-${sid()}` });
  const svc = makeService();
  const token = signAssertion(claimsFor(email));

  const first = await svc.loginWithAssertion(token);
  assert.ok(first.accessToken);

  await assert.rejects(
    () => svc.loginWithAssertion(token),
    (err: any) => {
      assert.equal(err.code, 'AUTH_ASSERTION_REPLAYED');
      return true;
    },
  );
});

test('BAD SIGNATURE — signed by a key other than ALEMBIC_ASSERTION_VERIFY_KEY is refused', async () => {
  const email = `badsig-${sid()}@rawaroma.local`;
  await makeActiveUser({ email });
  const svc = makeService();
  const token = signAssertion(claimsFor(email), otherPrivate);
  await assert.rejects(
    () => svc.loginWithAssertion(token),
    (err: any) => {
      assert.equal(err.code, 'AUTH_ASSERTION_INVALID');
      return true;
    },
  );
});

test('EXPIRED — an assertion past its exp is refused', async () => {
  const email = `expired-${sid()}@rawaroma.local`;
  await makeActiveUser({ email });
  const svc = makeService();
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signAssertion(claimsFor(email, { iat: nowSec - 120, exp: nowSec - 60 }));
  await assert.rejects(
    () => svc.loginWithAssertion(token),
    (err: any) => {
      assert.equal(err.code, 'AUTH_ASSERTION_INVALID');
      return true;
    },
  );
});

test('WRONG AUDIENCE — an assertion minted for a different service is refused', async () => {
  const email = `wrongaud-${sid()}@rawaroma.local`;
  await makeActiveUser({ email });
  const svc = makeService();
  const token = signAssertion(claimsFor(email, { aud: 'some-other-service' }));
  await assert.rejects(
    () => svc.loginWithAssertion(token),
    (err: any) => {
      assert.equal(err.code, 'AUTH_ASSERTION_INVALID');
      return true;
    },
  );
});

test('no ALEMBIC_ASSERTION_VERIFY_KEY configured -> feature-disabled, not a crash', async () => {
  const svc = makeService({ ALEMBIC_ASSERTION_VERIFY_KEY: '' });
  const token = signAssertion(claimsFor('whoever@rawaroma.local'));
  await assert.rejects(
    () => svc.loginWithAssertion(token),
    (err: any) => {
      assert.equal(err.code, 'FEATURE_DISABLED');
      return true;
    },
  );
});

/* ── PASSWORD SIGN-IN IS RETIRED FOR LAUNCH ──────────────────────────────── */

test('password login is refused in production mode, unconditionally', async () => {
  const svc = makeService({ APP_ENV: 'prod', PASSWORD_LOGIN_ENABLED: 'true' });
  await assert.rejects(
    () => svc.login('anybody@rawaroma.local', 'whatever-password'),
    (err: any) => {
      assert.equal(err.code, 'AUTH_FORBIDDEN');
      assert.match(err.message, /ALEMBIC/);
      return true;
    },
  );
});

test('password login is refused OUTSIDE production too, by default (PASSWORD_LOGIN_ENABLED=false)', async () => {
  const svc = makeService({ APP_ENV: 'dev' });
  await assert.rejects(
    () => svc.login('anybody@rawaroma.local', 'whatever-password'),
    (err: any) => {
      assert.equal(err.code, 'AUTH_FORBIDDEN');
      return true;
    },
  );
});

test('the non-prod escape hatch (PASSWORD_LOGIN_ENABLED=true, APP_ENV!=prod) lets the '
  + 'password PATH run — proven by it failing on invalid credentials rather than the retirement gate', async () => {
  const svc = makeService({ APP_ENV: 'dev', PASSWORD_LOGIN_ENABLED: 'true' });
  await assert.rejects(
    () => svc.login(`nobody-${sid()}@rawaroma.local`, 'whatever-password'),
    (err: any) => {
      // Reached real credential-checking logic, not the retirement refusal.
      assert.equal(err.code, 'AUTH_INVALID_CREDENTIALS');
      return true;
    },
  );
});

test('setPassword is likewise refused once password sign-in is retired', async () => {
  const email = `setpw-${sid()}@rawaroma.local`;
  const userId = await makeActiveUser({ email });
  const svc = makeService({ APP_ENV: 'prod' });
  await assert.rejects(
    () => svc.setPassword(userId, 'a-new-password-123', principal({ roles: ['owner'] })),
    (err: any) => {
      assert.equal(err.code, 'AUTH_FORBIDDEN');
      return true;
    },
  );
});

/* ── S3 SECURITY REVIEW ITEM 1 — SUBJECT BINDING, NOT EMAIL-ONLY MAPPING ───────────────────── */

test('first successful assertion login BINDS alembic_subject on the matched row', async () => {
  const email = `bind-${sid()}@rawaroma.local`;
  const userId = await makeActiveUser({ email });
  const svc = makeService();
  const sub = `staff:${email}`;
  await svc.loginWithAssertion(signAssertion(claimsFor(email, { sub })));

  const row = (await db.select({ alembicSubject: userMaster.alembicSubject }).from(userMaster)
    .where(eq(userMaster.userId, userId)))[0];
  assert.equal(row?.alembicSubject, sub);
});

test('once bound, a SECOND assertion for the SAME subject logs in by subject even if email '
  + 'lookup would also have matched', async () => {
  const email = `rebind-${sid()}@rawaroma.local`;
  await makeActiveUser({ email, roleCode: `role-${sid()}` });
  const svc = makeService();
  const sub = `staff:${email}`;
  await svc.loginWithAssertion(signAssertion(claimsFor(email, { sub, jti: randomUUID() })));
  // A second, later assertion for the same subject (fresh jti) still succeeds.
  const second = await svc.loginWithAssertion(signAssertion(claimsFor(email, { sub, jti: randomUUID() })));
  assert.ok(second.accessToken);
});

test('VAULT-TAKEOVER GUARD — an assertion presenting the right email but a DIFFERENT subject '
  + 'than the one already bound is refused, never silently re-bound', async () => {
  const email = `hijack-${sid()}@rawaroma.local`;
  await makeActiveUser({ email });
  const svc = makeService();
  const legitSub = `staff:${email}`;
  await svc.loginWithAssertion(signAssertion(claimsFor(email, { sub: legitSub, jti: randomUUID() })));

  // Attacker retargeted the row's email (e.g. via a since-closed edit-service path) to an
  // address they control on ALEMBIC, then presents an assertion for THAT ALEMBIC identity
  // naming the same RawProd email. Must be refused, not treated as a legitimate second login.
  const attackerSub = `staff:attacker-${sid()}@evil.example`;
  await assert.rejects(
    () => svc.loginWithAssertion(signAssertion(claimsFor(email, { sub: attackerSub, jti: randomUUID() }))),
    (err: any) => {
      assert.equal(err.code, 'AUTH_FORBIDDEN');
      assert.match(err.message, /different ALEMBIC identity/);
      return true;
    },
  );
});

/* ── S3 SECURITY REVIEW ITEM 12 — status column, not just is_active ────────────────────────── */

test('a row suspended via `status` (is_active left true) is refused just like is_active=false', async () => {
  const email = `statussuspend-${sid()}@rawaroma.local`;
  const userId = await makeActiveUser({ email, isActive: true });
  await db.update(userMaster).set({ status: 'SUSPENDED' }).where(eq(userMaster.userId, userId));
  const svc = makeService();
  await assert.rejects(
    () => svc.loginWithAssertion(signAssertion(claimsFor(email))),
    (err: any) => {
      assert.equal(err.code, 'AUTH_FORBIDDEN');
      return true;
    },
  );
});

test('a row with status=ACTIVE (or no status set) is not refused on status grounds', async () => {
  const email = `statusactive-${sid()}@rawaroma.local`;
  const userId = await makeActiveUser({ email });
  await db.update(userMaster).set({ status: 'ACTIVE' }).where(eq(userMaster.userId, userId));
  const svc = makeService();
  const out = await svc.loginWithAssertion(signAssertion(claimsFor(email)));
  assert.ok(out.accessToken);
});

/* ── S3 SECURITY REVIEW ITEM 13 — random per-session sid, never the userId ─────────────────── */

test('the minted access token carries a random sid, not the userId', async () => {
  const email = `sidcheck-${sid()}@rawaroma.local`;
  const userId = await makeActiveUser({ email });
  const svc = makeService();
  const out = await svc.loginWithAssertion(signAssertion(claimsFor(email)));
  const config = testConfig();
  const jwt = new JwtService(config);
  const claims = await jwt.verifyAccess(out.accessToken);
  assert.notEqual(claims.sid, userId);
  // A UUID-shaped random id, not a recognisable derivative of the userId.
  assert.match(claims.sid, /^[0-9a-f-]{36}$/i);
});

test('two separate logins for the same user mint two DIFFERENT sids', async () => {
  const email = `sidunique-${sid()}@rawaroma.local`;
  await makeActiveUser({ email });
  const svc = makeService();
  const config = testConfig();
  const jwt = new JwtService(config);
  const first = await svc.loginWithAssertion(signAssertion(claimsFor(email, { jti: randomUUID() })));
  const second = await svc.loginWithAssertion(signAssertion(claimsFor(email, { jti: randomUUID() })));
  const c1 = await jwt.verifyAccess(first.accessToken);
  const c2 = await jwt.verifyAccess(second.accessToken);
  assert.notEqual(c1.sid, c2.sid);
});

/* ── S3 SECURITY REVIEW ITEM 2 — auth_time carried from the assertion, used by FreshAuthGuard ─ */

test('the minted access token\'s authTime comes from the assertion\'s auth_time, not "now"', async () => {
  const email = `authtime-${sid()}@rawaroma.local`;
  await makeActiveUser({ email });
  const svc = makeService();
  const nowSec = Math.floor(Date.now() / 1000);
  const staleAuthTime = nowSec - 3600; // proved an hour ago (e.g. a long-lived ALEMBIC session)
  const out = await svc.loginWithAssertion(signAssertion(claimsFor(email, { auth_time: staleAuthTime })));
  const config = testConfig();
  const jwt = new JwtService(config);
  const claims: any = await jwt.verifyAccess(out.accessToken);
  assert.equal(claims.authTime, staleAuthTime);
  // authTime must genuinely differ from iat here — otherwise this test could not distinguish
  // "carried from the assertion" from "just stamped as now" (iat always IS now).
  assert.notEqual(claims.authTime, claims.iat);
});

/* ── S3 SECURITY REVIEW ITEM 4 — Postgres-backed jti replay store (cross-instance) ─────────── */

test('REPLAY IS BLOCKED ACROSS SEPARATE AuthService INSTANCES sharing one Postgres — proves '
  + 'the store is not the old in-process Map (which a second process/instance would not see)', async () => {
  const email = `crossproc-${sid()}@rawaroma.local`;
  await makeActiveUser({ email, roleCode: `role-${sid()}` });
  const token = signAssertion(claimsFor(email));

  // Two independently-constructed AuthService instances — simulating two API processes —
  // sharing the same underlying Postgres connection the test harness provides.
  const svcA = makeService();
  const svcB = makeService();

  const first = await svcA.loginWithAssertion(token);
  assert.ok(first.accessToken);

  await assert.rejects(
    () => svcB.loginWithAssertion(token),
    (err: any) => {
      assert.equal(err.code, 'AUTH_ASSERTION_REPLAYED');
      return true;
    },
  );
});

test('production refuses ALEMBIC sign-in while target/tenant binding is unconfigured', async () => {
  const email = `admin-${sid()}@rawaroma.local`;
  await makeActiveUser({ email, roleCode: `role-${sid()}`, permissionCode: `perm-${sid()}` });
  const svc = makeService({ APP_ENV: 'prod' });
  await assert.rejects(() => svc.loginWithAssertion(signAssertion(claimsFor(email))),
    /must be set in production/);
});
