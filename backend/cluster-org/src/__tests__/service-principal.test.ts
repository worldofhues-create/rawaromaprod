/**
 * Lane vaultsetup — "Ruh (automation)", the non-login service principal that drafts Vault formula
 * shells (ServicePrincipalService). Real Postgres (backend/test-support), the real SecurityService
 * and AuthService.
 *
 *   two people  click 1 (an owner requests) opens a PENDING grant and gives Ruh nothing; the
 *               requester cannot approve it; a second, independent owner can — only then does Ruh
 *               hold `formulator`. The status names the people who may approve.
 *   never more  a service account may hold `formulator` only: vault_approver, owner, any role is
 *               refused (and audited), at request time and again at approval.
 *   no login    password, ALEMBIC assertion (no identity bind either), refresh, set-password and
 *               change-email all refuse it.
 *   token       minted only once the grant is approved; carries exactly the three drafting
 *               permissions — never formula:actual:read, never an approval permission; refused
 *               outright if Ruh were ever found holding one; each mint is audited.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign as edSign } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import { ConfigService, JwtService, type SecurityAuditEntry, type SecurityAuditSink } from '@core/backend-kernel';
import { SecurityService } from '../security/security.service.js';
import { AuthService } from '../auth/auth.service.js';
import { ServicePrincipalService, RUH_PRINCIPAL, RUH_DRAFTING_PERMISSIONS } from '../service-principal/service-principal.service.js';
import { ensureSchema, orgDb, orgSchema, principal, testClient, closeTestClient } from '../../../test-support/db.js';

const { roleMaster, permissionMaster, rolePermissionMapping, userRoleMapping, userMaster, vaultRoleGrantRequest } = orgSchema;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const config = new ConfigService({
  NODE_ENV: 'test',
  APP_ENV: 'dev',
  DATABASE_URL: 'postgres://unused/x',
  JWT_SECRET: 's'.repeat(32),
  ALEMBIC_ASSERTION_VERIFY_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  PASSWORD_LOGIN_ENABLED: 'true',
} as NodeJS.ProcessEnv);
const jwt = new JwtService(config);

let db: ReturnType<typeof orgDb>;
let audits: SecurityAuditEntry[] = [];
const sink: SecurityAuditSink = { async record(e) { audits.push(e); } };
let security: SecurityService;
let auth: AuthService;
let svc: ServicePrincipalService;

/** Two independent owners (B was not created by A) and a third account A created (a puppet). */
let ownerA: ReturnType<typeof principal>;
let ownerB: ReturnType<typeof principal>;
let puppetOfA: ReturnType<typeof principal>;

async function roleId(code: string, perms: string[] = []): Promise<string> {
  let id = (await db.select({ id: roleMaster.roleId }).from(roleMaster).where(eq(roleMaster.roleCode, code)).limit(1))[0]?.id;
  if (!id) {
    id = uuidv7();
    await db.insert(roleMaster).values({ roleId: id, roleCode: code, roleName: code, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test' });
  }
  for (const p of perms) {
    let pid = (await db.select({ id: permissionMaster.permissionId }).from(permissionMaster).where(eq(permissionMaster.permissionCode, p)).limit(1))[0]?.id;
    if (!pid) {
      pid = uuidv7();
      await db.insert(permissionMaster).values({ permissionId: pid, permissionCode: p, permissionName: p, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test' });
    }
    await db.insert(rolePermissionMapping).values({ roleId: id, permissionId: pid, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test' }).onConflictDoNothing();
  }
  return id;
}

async function human(roleCode: string, createdBy = 'test') {
  const userId = uuidv7();
  const email = `sp-${randomUUID().slice(0, 8)}@rawaroma.local`;
  await db.insert(userMaster).values({ userId, email, userName: email, isActive: true, status: 'ACTIVE', createdBy, updatedBy: createdBy });
  await db.insert(userRoleMapping).values({ userId, roleId: await roleId(roleCode), status: 'ACTIVE', createdBy: 'test', updatedBy: 'test' });
  return principal({ userId, roles: [roleCode], permissions: ['iam:user_role_mapping:write', 'iam:user_role_mapping:read'] });
}

/** A clean slate for the one fixed-email Ruh account (this DB is reused across runs/files). */
async function resetRuh() {
  const rows = await db.select({ id: userMaster.userId }).from(userMaster).where(eq(userMaster.email, RUH_PRINCIPAL.email));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(vaultRoleGrantRequest).where(inArray(vaultRoleGrantRequest.userId, ids));
  await db.delete(userRoleMapping).where(inArray(userRoleMapping.userId, ids));
  await db.delete(userMaster).where(inArray(userMaster.userId, ids));
}

function signAssertion(email: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = { iss: 'alembic', aud: 'rawprod', sub: randomUUID(), tenant_id: 't1', org_id: 't1', email, roles: ['admin'], target: 'vault', iat: nowSec, exp: nowSec + 45, jti: randomUUID(), auth_time: nowSec - 5 };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc(claims)}`;
  return `${input}.${edSign(null, Buffer.from(input, 'utf8'), privateKey).toString('base64url')}`;
}

before(async () => {
  await ensureSchema();
  db = orgDb();
  security = new SecurityService(db as never, sink);
  auth = new AuthService(db as never, jwt, testClient(), config);
  svc = new ServicePrincipalService(db as never, jwt, security, sink);
  // The seed's formulator grant includes the three drafting permissions + plaintext read.
  await roleId('formulator', [...RUH_DRAFTING_PERMISSIONS, 'formula:actual:read', 'formula:formula_version:read']);
  await roleId('vault_approver', ['formula:formula_approval:write']);
  await resetRuh();
  ownerA = await human('owner');
  ownerB = await human('owner');
  puppetOfA = await human('admin', ownerA.userId);
});

afterAll(async () => {
  await closeTestClient();
});

test('before any click: no Ruh account, nothing to approve, and no token can be minted', async () => {
  const s = await svc.ruhStatus(ownerA);
  assert.equal(s.account, null);
  assert.deepEqual(s.formulator, { state: 'none' });
  assert.equal(s.you.canRequest, true);
  await assert.rejects(() => svc.mintVaultToken('test'), /Ruh is not set up yet/);
  // Only an owner/admin may set Ruh up.
  await assert.rejects(() => svc.requestFormulator(principal({ roles: ['production'] })), /Only an owner or admin/);
});

test('click 1: an owner\'s request creates the non-login account and a PENDING grant — Ruh holds nothing yet', async () => {
  audits = [];
  const s = await svc.requestFormulator(ownerA);
  assert.ok(s.account);
  const [row] = await db.select().from(userMaster).where(eq(userMaster.email, RUH_PRINCIPAL.email));
  assert.equal(row!.accountKind, 'SERVICE');
  assert.equal(row!.passwordHash, null);
  assert.equal(row!.alembicSubject, null);
  assert.equal(row!.userName, RUH_PRINCIPAL.userName);
  assert.equal(row!.createdBy, ownerA.userId);

  assert.equal(s.formulator.state, 'pending');
  if (s.formulator.state !== 'pending') return;
  assert.equal(s.formulator.requestedBy?.userId, ownerA.userId);
  const approverIds = s.formulator.approvers.map((a) => a.userId);
  assert.ok(approverIds.includes(ownerB.userId), 'an independent owner may approve');
  assert.ok(!approverIds.includes(ownerA.userId), 'the requester may not');
  assert.ok(!approverIds.includes(puppetOfA.userId), 'an account the requester created may not');
  assert.equal(s.you.canApprove, false);
  assert.match(s.you.note ?? '', /different owner or admin must approve/);
  assert.equal((await svc.ruhStatus(ownerB)).you.canApprove, true);

  assert.ok(audits.some((a) => a.action === 'security.service_principal.created' && a.actorId === ownerA.userId));
  assert.ok(audits.some((a) => a.action === 'security.vault_role.requested' && a.actorId === ownerA.userId));
  const mappings = await db.select().from(userRoleMapping).where(eq(userRoleMapping.userId, row!.userId));
  assert.equal(mappings.length, 0, 'a pending request grants nothing');
  await assert.rejects(() => svc.mintVaultToken('test'), /needs a second owner's approval/);

  // A second click is idempotent: still the one pending request.
  const again = await svc.requestFormulator(ownerB);
  assert.equal(again.formulator.state, 'pending');
  const pending = await db.select().from(vaultRoleGrantRequest).where(eq(vaultRoleGrantRequest.userId, row!.userId));
  assert.equal(pending.length, 1);
});

test('click 2 needs a different, independent person: the requester and their puppet are refused; owner B approves', async () => {
  const s = await svc.ruhStatus(ownerA);
  assert.equal(s.formulator.state, 'pending');
  if (s.formulator.state !== 'pending') return;
  const requestId = s.formulator.requestId;
  await assert.rejects(() => security.approveVaultRoleGrant(requestId, ownerA), /cannot approve your own/);
  await assert.rejects(() => security.approveVaultRoleGrant(requestId, puppetOfA), /created by the same person/);
  await security.approveVaultRoleGrant(requestId, ownerB);
  const done = await svc.ruhStatus(ownerA);
  assert.equal(done.formulator.state, 'active');
});

test('never more than formulator: vault_approver, owner and any other role are refused for the service account, and audited', async () => {
  const ruh = (await svc.findRuh())!;
  audits = [];
  for (const code of ['vault_approver', 'owner', 'admin']) {
    const rid = await roleId(code);
    await assert.rejects(
      () => security.createUserRole({ userId: ruh.userId, roleId: rid }, ownerB),
      /A service account may only hold the formulator role/,
      code,
    );
  }
  assert.equal(audits.filter((a) => a.action === 'security.service_role.refused').length, 3);
  // A request smuggled in for a non-formulator role (bypassing createUserRole) dies at approval.
  const [req] = await db.insert(vaultRoleGrantRequest).values({
    userId: ruh.userId, roleId: await roleId('vault_approver'), grantStatus: 'PENDING',
    expiresDt: new Date(Date.now() + 3600_000), status: 'ACTIVE', createdBy: ownerA.userId, updatedBy: ownerA.userId,
  }).returning();
  await assert.rejects(() => security.approveVaultRoleGrant(req!.vaultRoleGrantRequestId, ownerB), /A service account may only hold the formulator role/);
  const [after] = await db.select().from(vaultRoleGrantRequest).where(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, req!.vaultRoleGrantRequestId));
  assert.equal(after!.grantStatus, 'PENDING', 'the refused approval changed nothing');
  await db.delete(vaultRoleGrantRequest).where(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, req!.vaultRoleGrantRequestId));
});

test('the token: exactly the three drafting permissions, the formulator role, a fresh authTime — and every mint is audited', async () => {
  audits = [];
  const { token, userId } = await svc.mintVaultToken('draft formula shells for 3 product(s)');
  const claims = await jwt.verifyAccess(token);
  assert.equal(claims.sub, userId);
  assert.deepEqual([...claims.perms].sort(), [...RUH_DRAFTING_PERMISSIONS].sort());
  assert.ok(!claims.perms.includes('formula:actual:read'));
  assert.ok(!claims.perms.some((p) => p.startsWith('formula:formula_approval')));
  assert.deepEqual(claims.roles, ['formulator']);
  assert.ok(Math.abs(claims.authTime - Date.now() / 1000) < 10);
  const minted = audits.find((a) => a.action === 'security.service_token.minted');
  assert.ok(minted);
  assert.equal(minted!.entityId, userId);
  assert.match(minted!.reason ?? '', /draft formula shells/);
});

test('a decision permission on Ruh (impossible through the app) makes it refuse to act at all', async () => {
  const ruh = (await svc.findRuh())!;
  const leak = await roleId(`leak-${randomUUID().slice(0, 6)}`, ['formula:formula_approval:write']);
  await db.insert(userRoleMapping).values({ userId: ruh.userId, roleId: leak, status: 'ACTIVE', createdBy: 'test', updatedBy: 'test' });
  try {
    audits = [];
    await assert.rejects(() => svc.mintVaultToken('test'), /must never hold an approval permission/);
    assert.ok(audits.some((a) => a.action === 'security.service_token.refused' && a.result === 'refuse'));
  } finally {
    await db.delete(userRoleMapping).where(eq(userRoleMapping.roleId, leak));
  }
});

test('switched off (is_active=false): no token', async () => {
  const ruh = (await svc.findRuh())!;
  await db.update(userMaster).set({ isActive: false }).where(eq(userMaster.userId, ruh.userId));
  try {
    await assert.rejects(() => svc.mintVaultToken('test'), /switched off/);
  } finally {
    await db.update(userMaster).set({ isActive: true }).where(eq(userMaster.userId, ruh.userId));
  }
});

test('no login, ever: assertion (and no identity bind), password, refresh, set-password and change-email all refuse the service account', async () => {
  const ruh = (await svc.findRuh())!;
  await assert.rejects(() => auth.loginWithAssertion(signAssertion(RUH_PRINCIPAL.email)), /service account; it cannot sign in/);
  const [row] = await db.select().from(userMaster).where(eq(userMaster.userId, ruh.userId));
  assert.equal(row!.alembicSubject, null, 'never bound to an ALEMBIC identity');
  await assert.rejects(() => auth.login(RUH_PRINCIPAL.email, 'anything-at-all'), /Invalid credentials/);
  const refresh = await jwt.signRefresh({ sub: ruh.userId, sid: randomUUID(), authTime: Math.floor(Date.now() / 1000) });
  await assert.rejects(() => auth.refresh(refresh), /Service accounts do not hold sessions/);
  await assert.rejects(() => auth.setPassword(ruh.userId, 'Sup3rSecret!pass', ownerA), /never has a password/);
  await assert.rejects(() => security.changeUserEmail(ruh.userId, 'someone@rawaroma.local', ownerA), /service account/);
  // The database refuses a password or an identity on a SERVICE row, whatever the code path.
  await assert.rejects(() => testClient()`update iam.user_master set password_hash = 'x' where user_id = ${ruh.userId}`, /user_master_service_no_login_chk/);
  await assert.rejects(() => testClient()`update iam.user_master set alembic_subject = ${'staff:' + randomUUID()} where user_id = ${ruh.userId}`, /user_master_service_no_login_chk/);
});
