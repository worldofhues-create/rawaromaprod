/**
 * Lane token-rp (RawProd release fix) — the access token no longer carries every permission.
 *
 * An owner holds 257 permissions; carried inline they made a 12,355-byte JWT, over nginx's 8 KB
 * default header limit, so owners got "400 Request Header Or Cookie Too Large" on their first
 * write. The token now carries `roles` + `pv` + only the vault-scoped subset (`formula:*`/
 * `vault:*`). On the main app box `JwtAuthGuard` resolves the permission set from the token's
 * roles server-side (cluster-org's `RolePermissionResolver`, short-lived cache, invalidated on
 * every role-grant write); on the Vault box, which has no IAM tables, it reads the vault-scoped
 * subset the token carries (`TokenCarriedPermissionResolver`).
 *
 * Real Postgres (backend/test-support), real `JwtService`/`JwtAuthGuard`/`PermissionsGuard`,
 * real `@Permissions(...)` metadata on real controllers, and the real seed grants
 * (scripts/ra-roles.ts over RA_PERMISSIONS), not hand-typed stand-ins. Role codes carry a random
 * suffix so this file never adds grants to a role another test file reads.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign as edSign } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import {
  ConfigService,
  DomainError,
  JwtAuthGuard,
  JwtService,
  PERMISSION_RESOLVER,
  PG_CLIENT,
  PermissionsGuard,
  TokenCarriedPermissionResolver,
  isTokenCarriedPermission,
  type PermissionResolver,
} from '@core/backend-kernel';
import { ClusterOrgModule } from '@ra/cluster-org';
import { AuthService } from '../../../cluster-org/src/auth/auth.service.js';
import {
  ROLE_PERMISSION_CACHE_TTL_MS,
  RolePermissionResolver,
} from '../../../cluster-org/src/auth/role-permission.resolver.js';
import { SecurityController } from '../../../cluster-org/src/security/security.controller.js';
import { SecurityService } from '../../../cluster-org/src/security/security.service.js';
import { FormulasController } from '../../../cluster-formula/src/formulas/formulas.controller.js';
import { ApprovalsController } from '../../../cluster-formula/src/approvals/approvals.controller.js';
import {
  ensureSchema,
  orgDb,
  orgSchema,
  testClient,
  closeTestClient,
  principal,
} from '../../../test-support/db.js';
import { ROLES, CAPABILITY_PERMISSIONS, VAULT_PLAINTEXT_PERMISSION } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const { userMaster, roleMaster, permissionMaster, rolePermissionMapping, userRoleMapping } = orgSchema;

let db: ReturnType<typeof orgDb>;

before(async () => {
  await ensureSchema();
  db = orgDb();
});

afterAll(async () => {
  await closeTestClient();
});

/* ── fixtures ───────────────────────────────────────────────────────────────────────────── */

const sid = () => randomUUID().slice(0, 8);

/** The seed's real grant for a role (what db-seed.ts writes into role_permission_mapping). */
function seedGrant(roleCode: string): string[] {
  const role = ROLES.find((r) => r.code === roleCode);
  assert.ok(role, `role '${roleCode}' must exist in the seed catalog`);
  return [...RA_PERMISSIONS, ...CAPABILITY_PERMISSIONS].filter((p) => role!.select(p));
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const VERIFY_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function config(): ConfigService {
  return new ConfigService({
    NODE_ENV: 'test',
    APP_ENV: 'dev',
    DATABASE_URL: 'postgres://apple@localhost:5432/unused',
    JWT_SECRET: 't'.repeat(32),
    ALEMBIC_ASSERTION_VERIFY_KEY: VERIFY_KEY_B64,
  } as NodeJS.ProcessEnv);
}

const jwt = new JwtService(config());

/** An ALEMBIC-shaped assertion (same wire format auth-service-assertion.test.ts signs). */
function signAssertion(email: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'alembic', aud: 'rawprod', sub: randomUUID(), tenant_id: 't1', org_id: 't1', email,
    roles: ['admin'], target: 'factory', iat: nowSec, exp: nowSec + 45, jti: randomUUID(),
    auth_time: nowSec - 30,
  };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const signingInput = `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc(claims)}`;
  return `${signingInput}.${edSign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')}`;
}

/** A role with exactly these permissions (permission rows are find-or-create by code). */
async function makeRole(prefix: string, codes: string[]): Promise<{ roleId: string; roleCode: string }> {
  const roleId = uuidv7();
  const roleCode = `${prefix}-${sid()}`;
  await db.insert(roleMaster).values({
    roleId, roleCode, roleName: roleCode, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test',
  });
  if (codes.length > 0) {
    await db
      .insert(permissionMaster)
      .values(codes.map((c) => ({
        permissionId: uuidv7(), permissionCode: c, permissionName: c,
        status: 'ACTIVE', createdBy: 'test', updatedBy: 'test',
      })))
      .onConflictDoNothing();
    const perms = await db
      .select({ id: permissionMaster.permissionId })
      .from(permissionMaster)
      .where(inArray(permissionMaster.permissionCode, codes));
    assert.equal(perms.length, codes.length);
    await db.insert(rolePermissionMapping).values(perms.map((p) => ({
      roleId, permissionId: p.id, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test',
    })) as never);
  }
  return { roleId, roleCode };
}

async function mappingId(roleId: string): Promise<{ mappingId: string; permissionId: string }> {
  const [row] = await db
    .select({ mappingId: rolePermissionMapping.rolePermissionMappingId, permissionId: rolePermissionMapping.permissionId })
    .from(rolePermissionMapping)
    .where(inArray(rolePermissionMapping.roleId, [roleId]));
  assert.ok(row);
  return { mappingId: row!.mappingId, permissionId: row!.permissionId! };
}

/** Mint an access token the way AuthService does: the role's full grant is passed in, and
 *  JwtService decides what actually goes into the token. */
async function tokenFor(roles: string[], perms: string[] = []): Promise<string> {
  return jwt.signAccess({
    sub: uuidv7(), portal: 'owner', roles, perms, pv: 1, sid: randomUUID(),
    authTime: Math.floor(Date.now() / 1000),
  });
}

function rawPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

/** One request through the real edge chain: JwtAuthGuard (with this process's resolver), then
 *  PermissionsGuard against the handler's real @Permissions metadata. */
async function request(resolver: PermissionResolver, Controller: Function, method: string, token: string) {
  const handler = (Controller.prototype as Record<string, unknown>)[method];
  const req: { headers: Record<string, string>; user?: { permissions: string[]; authTime: number } } = {
    headers: { authorization: `Bearer ${token}` },
  };
  const ctx = {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
  const reflector = new Reflector();
  await new JwtAuthGuard(reflector, jwt, resolver).canActivate(ctx);
  let allowed: boolean;
  try {
    allowed = new PermissionsGuard(reflector).canActivate(ctx);
  } catch (err) {
    assert.ok(err instanceof DomainError, String(err));
    assert.equal((err as DomainError).status, 403);
    allowed = false;
  }
  return { allowed, user: req.user! };
}

/** A resolver whose clock the test can move — stands in for ANOTHER API process. */
class OtherProcessResolver extends RolePermissionResolver {
  clock = Date.now();
  protected override now(): number {
    return this.clock;
  }
}

/* ── 1. size ───────────────────────────────────────────────────────────────────────────── */

test('an owner access token is under 2 KB (was 12,355 bytes) and loses nothing: all 257 of the '
  + "owner's permissions still resolve from its roles", async (t) => {
  const ownerGrant = seedGrant('owner');
  assert.equal(ownerGrant.length, 257);
  const { roleId, roleCode } = await makeRole('owner', ownerGrant);
  const email = `owner-${sid()}@rawaroma.local`;
  const userId = uuidv7();
  await db.insert(userMaster).values({ userId, email, userName: email, isActive: true, createdBy: 'test', updatedBy: 'test' });
  await db.insert(userRoleMapping).values({
    userRoleMappingId: uuidv7(), userId, roleId, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test',
  });

  const cfg = config();
  const auth = new AuthService(db, new JwtService(cfg), testClient(), cfg);
  const { accessToken } = await auth.loginWithAssertion(signAssertion(email));
  t.diagnostic(`owner access token: ${accessToken.length} bytes`);
  assert.ok(accessToken.length < 2048, `owner token is ${accessToken.length} bytes`);

  // What the token carries: the roles, and only the vault-scoped part of the grant.
  const raw = rawPayload(accessToken);
  assert.deepEqual(raw.roles, [roleCode]);
  const carried = raw.perms as string[];
  assert.deepEqual([...carried].sort(), ownerGrant.filter(isTokenCarriedPermission).sort());
  assert.ok(carried.every(isTokenCarriedPermission));
  assert.ok(!carried.includes(VAULT_PLAINTEXT_PERMISSION));

  // What the main box enforces: the whole grant, resolved from those roles.
  const { user } = await request(new RolePermissionResolver(db), SecurityController, 'listRolePermissions', accessToken);
  assert.deepEqual([...user.permissions].sort(), [...ownerGrant].sort());

  // /me still hands the UI the full list.
  const me = await auth.me(principal({ userId, roles: [roleCode], permissions: [] }));
  assert.deepEqual([...me.permissions].sort(), [...ownerGrant].sort());
});

/* ── 2. resolution from roles ──────────────────────────────────────────────────────────── */

test('a permission check resolves from the token\'s roles, server-side, through the real guard chain', async () => {
  const { roleCode } = await makeRole('rp-reader', ['iam:role_permission_mapping:read']);
  const authTime = Math.floor(Date.now() / 1000) - 120;
  const token = await jwt.signAccess({
    sub: uuidv7(), portal: 'owner', roles: [roleCode],
    // Whatever a caller passes, a non-vault permission never reaches the token.
    perms: ['iam:role_permission_mapping:read', 'iam:role_permission_mapping:write'],
    pv: 1, sid: randomUUID(), authTime,
  });
  assert.deepEqual(rawPayload(token).perms, []);

  const resolver = new RolePermissionResolver(db);
  const read = await request(resolver, SecurityController, 'listRolePermissions', token);
  assert.equal(read.allowed, true);
  assert.deepEqual(read.user.permissions, ['iam:role_permission_mapping:read']);
  assert.equal(read.user.authTime, authTime, 'authTime still comes from the token');
  assert.equal((await request(resolver, SecurityController, 'createRolePermission', token)).allowed, false);

  // A role with no grants resolves to nothing; so does an unknown role code.
  const { roleCode: empty } = await makeRole('rp-empty', []);
  assert.deepEqual(await resolver.permissionsForRoles([empty, `no-such-role-${sid()}`]), []);
  assert.equal((await request(resolver, SecurityController, 'listRolePermissions', await tokenFor([empty]))).allowed, false);
});

/* ── 3. revocation ─────────────────────────────────────────────────────────────────────── */

test('a revoked role grant is denied on the next request in the process that revoked it, and in '
  + 'every other process once the cache TTL has passed; a re-grant is honoured the same way', async () => {
  const { roleId, roleCode } = await makeRole('rp-revoke', ['iam:role_permission_mapping:read']);
  const { mappingId: mapping, permissionId } = await mappingId(roleId);
  const token = await tokenFor([roleCode]);

  const here = new RolePermissionResolver(db); // the process that handles the revoke
  const elsewhere = new OtherProcessResolver(db); // another API process
  const security = new SecurityService(db as never, undefined, here);
  const owner = principal({ roles: ['owner'] });

  assert.equal((await request(here, SecurityController, 'listRolePermissions', token)).allowed, true);
  assert.equal((await request(elsewhere, SecurityController, 'listRolePermissions', token)).allowed, true);

  await security.revokeRolePermission(mapping, owner);

  // Same process: invalidated by the revoke itself, so the very next request is denied.
  assert.equal((await request(here, SecurityController, 'listRolePermissions', token)).allowed, false);
  // Another process: its cached read stands until the TTL (seconds, far inside the access-token
  // lifetime, which is how long a revoke took to reach a held token before), then it re-reads.
  assert.equal((await request(elsewhere, SecurityController, 'listRolePermissions', token)).allowed, true);
  elsewhere.clock += ROLE_PERMISSION_CACHE_TTL_MS + 1;
  assert.equal((await request(elsewhere, SecurityController, 'listRolePermissions', token)).allowed, false);

  // Re-granting through the real service reaches this process on the next request too.
  await security.createRolePermission({ roleId, permissionId } as never, owner);
  assert.equal((await request(here, SecurityController, 'listRolePermissions', token)).allowed, true);
});

/* ── 4. the Vault invariant ────────────────────────────────────────────────────────────── */

test('the Vault invariant holds on both boxes: formula:actual:read only for formulator/vault_approver, '
  + 'never for owner or super_admin', async () => {
  const owner = await makeRole('owner', seedGrant('owner'));
  const formulator = await makeRole('formulator', seedGrant('formulator'));
  const approver = await makeRole('vault_approver', seedGrant('vault_approver'));
  const mainBox = new RolePermissionResolver(db);
  const vaultBox = new TokenCarriedPermissionResolver();

  // Tokens minted as AuthService mints them: the user's full grant in, JwtService narrows it.
  const ownerRoles = [owner.roleCode];
  // super_admin's blanket bypass must not reach the recipe either (it does reach approve at the
  // guard layer, by design: vault-rbac.test.ts documents that, and ApprovalsService's SoD and
  // @FreshAuth guard it; this lane changes neither).
  const superRoles = [owner.roleCode, 'super_admin'];
  const ownerToken = await tokenFor(ownerRoles, await mainBox.permissionsForRoles(ownerRoles));
  const superToken = await tokenFor(superRoles, await mainBox.permissionsForRoles(superRoles));
  const formulatorToken = await tokenFor([formulator.roleCode], await mainBox.permissionsForRoles([formulator.roleCode]));
  const approverToken = await tokenFor([approver.roleCode], await mainBox.permissionsForRoles([approver.roleCode]));

  for (const [box, resolver] of [['main', mainBox], ['vault', vaultBox]] as const) {
    const actual = (token: string) => request(resolver, FormulasController, 'getActualFormula', token);
    const approve = (token: string) => request(resolver, ApprovalsController, 'approveVersion', token);
    assert.equal((await actual(ownerToken)).allowed, false, `${box}: owner must not read the recipe`);
    assert.equal((await actual(superToken)).allowed, false, `${box}: owner + super_admin must not read the recipe`);
    assert.equal((await approve(ownerToken)).allowed, false, `${box}: owner must not approve`);
    assert.equal((await actual(formulatorToken)).allowed, true, `${box}: formulator reads the recipe`);
    assert.equal((await actual(approverToken)).allowed, true, `${box}: vault_approver reads the recipe`);
    assert.equal((await approve(approverToken)).allowed, true, `${box}: vault_approver approves`);
    assert.equal((await approve(formulatorToken)).allowed, false, `${box}: formulator never approves (SoD)`);
  }

  // The Vault box sees exactly the vault-scoped part of what the main box resolves: same codes.
  for (const [roles, token] of [[ownerRoles, ownerToken], [superRoles, superToken], [[formulator.roleCode], formulatorToken]] as const) {
    const onVault = (await request(vaultBox, FormulasController, 'getActualFormula', token)).user.permissions;
    const onMain = await mainBox.permissionsForRoles(roles);
    assert.deepEqual([...onVault].sort(), onMain.filter(isTokenCarriedPermission).sort());
  }
});

/* ── 5. wiring ─────────────────────────────────────────────────────────────────────────── */

test('AppModule wiring: ClusterOrgModule hands a root-level JwtAuthGuard its RolePermissionResolver', async () => {
  // The same shape as AppModule: JwtAuthGuard is a ROOT-module provider (there, APP_GUARD) and
  // PERMISSION_RESOLVER comes from the imported ClusterOrgModule's exports. JwtAuthGuard's
  // resolver is not optional, so a missing binding fails this boot, never a request.
  const cfg = config();
  @Global()
  @Module({
    providers: [
      { provide: PG_CLIENT, useValue: testClient() },
      { provide: ConfigService, useValue: cfg },
      { provide: JwtService, useValue: new JwtService(cfg) },
    ],
    exports: [PG_CLIENT, ConfigService, JwtService],
  })
  class KernelStub {}
  @Module({ imports: [KernelStub, ClusterOrgModule], providers: [JwtAuthGuard] })
  class Root {}

  const app = await NestFactory.createApplicationContext(Root, { logger: false });
  try {
    const guard = app.get(JwtAuthGuard);
    const resolver = (guard as unknown as { permissionResolver: unknown }).permissionResolver;
    assert.ok(resolver instanceof RolePermissionResolver);
    assert.equal(resolver, app.get(PERMISSION_RESOLVER, { strict: false }));
    // SecurityService invalidates that same instance on a grant change.
    const security = app.get(SecurityService, { strict: false });
    assert.equal((security as unknown as { permissionResolver: unknown }).permissionResolver, resolver);
  } finally {
    await app.close();
  }
});
