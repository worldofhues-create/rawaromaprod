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
