/**
 * Security review S1, items 1 + 6 — SecurityService.createRolePermission /
 * SecurityService.createUserRole. Real Postgres (backend/test-support pattern; the iam RBAC
 * tables role_master/permission_master/role_permission_mapping/user_role_mapping were added to
 * backend/test-support/schema.sql for this lane — see that file's "RP-S1" section).
 *
 * Item 1: POST /v1/role-permissions used to accept ANY role<->permission pair as long as the
 * CALLER held the ordinary `iam:role_permission_mapping:write` permission — an `admin` could
 * hand `owner` (or any role) `formula:actual:read`/`vault:*`/`formula:formula_approval:write`/
 * `formula:formula_access_policy:write`/`platformops:console:read`, completely bypassing the
 * go-live seed. createRolePermission now refuses any such mapping outright, regardless of the
 * caller, unless the target role is on the matching hard allow-list — and audits the refusal.
 *
 * Item 6: createUserRole's ordinary "you can only grant a role whose permissions are a subset
 * of your own" rule can NEVER be satisfied for formulator/vault_approver by owner/admin (they
 * structurally never hold vault:* / formula:actual:read themselves, §107) — before this fix
 * there was NO working path to ever assign these two roles to anyone. The explicit allow-list
 * exception fixes that, restricted to owner/admin, and hard-refuses self-assignment.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import type { SecurityAuditEntry, SecurityAuditSink } from '@core/backend-kernel';
import { SecurityService } from '../security/security.service.js';
import { ensureSchema, orgDb, orgSchema, principal, closeTestClient } from '../../../test-support/db.js';

const { roleMaster, permissionMaster, userMaster } = orgSchema;

let db: ReturnType<typeof orgDb>;
let audits: SecurityAuditEntry[];
const auditSink: SecurityAuditSink = {
  async record(entry) {
    audits.push(entry);
  },
};
let svc: SecurityService;

before(async () => {
  await ensureSchema();
  db = orgDb();
  svc = new SecurityService(db as any, auditSink);
});

afterAll(async () => {
  await closeTestClient();
});

/** Short, collision-safe suffix (role_code/permission_code are varchar(50) — a full uuidv7 is
 * too long once prefixed with a readable label). */
const sid = () => randomUUID().slice(0, 8);

async function makeRole(codePrefix: string): Promise<string> {
  const roleId = uuidv7();
  const code = `${codePrefix}-${sid()}`;
  await db.insert(roleMaster).values({
    roleId,
    roleCode: code,
    roleName: code,
    status: 'ACTIVE',
    createdBy: 'test',
    updatedBy: 'test',
  });
  return roleId;
}

/** role_code is UNIQUE — the exact literal codes SecurityService branches on ('formulator',
 * 'vault_approver') can only exist ONCE across this whole test file/run, so find-or-create by
 * the exact code (idempotent, same pattern scripts/db-seed.ts uses) instead of inserting a
 * fresh row with that literal every test. */
async function findOrMakeRoleByCode(code: string): Promise<string> {
  const existing = (
    await db.select({ id: roleMaster.roleId }).from(roleMaster).where(eq(roleMaster.roleCode, code)).limit(1)
  )[0];
  if (existing) return existing.id;
  const roleId = uuidv7();
  await db.insert(roleMaster).values({
    roleId,
    roleCode: code,
    roleName: code,
    status: 'ACTIVE',
    createdBy: 'test',
    updatedBy: 'test',
  });
  return roleId;
}

async function makePermission(codePrefix: string): Promise<string> {
  const permissionId = uuidv7();
  const code = `${codePrefix}-${sid()}`;
  await db.insert(permissionMaster).values({
    permissionId,
    permissionCode: code,
    permissionName: code,
    moduleName: code.split(':')[0],
    status: 'ACTIVE',
    createdBy: 'test',
    updatedBy: 'test',
  });
  return permissionId;
}

/** For the two EXACT-match sensitive codes (formula:formula_approval:write,
 * formula:formula_access_policy:write) — a random suffix would defeat the `===` check in
 * SecurityService, so find-or-create by the exact code (same reasoning as
 * findOrMakeRoleByCode). */
async function findOrMakeExactPermission(code: string): Promise<string> {
  const existing = (
    await db.select({ id: permissionMaster.permissionId }).from(permissionMaster).where(eq(permissionMaster.permissionCode, code)).limit(1)
  )[0];
  if (existing) return existing.id;
  const permissionId = uuidv7();
  await db.insert(permissionMaster).values({
    permissionId,
    permissionCode: code,
    permissionName: code,
    moduleName: code.split(':')[0],
    status: 'ACTIVE',
    createdBy: 'test',
    updatedBy: 'test',
  });
  return permissionId;
}

async function makeUser(emailPrefix: string): Promise<string> {
  const userId = uuidv7();
  const email = `${emailPrefix}-${sid()}@test.local`;
  await db.insert(userMaster).values({
    userId,
    userName: email,
    email,
    passwordHash: 'x',
    isActive: true,
    status: 'ACTIVE',
    createdBy: 'test',
    updatedBy: 'test',
  });
  return userId;
}

/* ── item 1: runtime role<->permission self-grant guard ─────────────────────────────────── */

test('item 1: refuses mapping formula:actual:read onto a role outside formulator/vault_approver', async () => {
  audits = [];
  const ownerRoleId = await makeRole('owner');
  const permId = await makePermission('formula:actual:read');
  const admin = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:role_permission_mapping:write'] });

  await assert.rejects(
    () => svc.createRolePermission({ roleId: ownerRoleId, permissionId: permId }, admin),
    (err: any) => {
      assert.equal(err.status, 403);
      return true;
    },
  );
  assert.equal(audits.length, 1, 'the refusal must be audited');
  assert.equal(audits[0]!.action, 'security.role_permission.refused');
  assert.equal(audits[0]!.result, 'refuse');
});

test('item 1: refuses mapping formula:formula_approval:write onto a non-vault_approver role', async () => {
  const someRoleId = await makeRole('floor');
  const permId = await findOrMakeExactPermission('formula:formula_approval:write');
  const admin = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:role_permission_mapping:write'] });
  await assert.rejects(() => svc.createRolePermission({ roleId: someRoleId, permissionId: permId }, admin));
});

test('review B: decision permissions never map onto formulator (formulators cannot approve each other)', async () => {
  const formulatorId = await findOrMakeRoleByCode('formulator');
  const approverId = await findOrMakeRoleByCode('vault_approver');
  const admin = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:role_permission_mapping:write'] });
  for (const code of ['formula:formula_approval:write', 'formula:formula_access_policy:write']) {
    const permId = await findOrMakeExactPermission(code);
    await assert.rejects(() => svc.createRolePermission({ roleId: formulatorId, permissionId: permId }, admin));
    /* control: the same permission still maps onto vault_approver */
    const row = await svc.createRolePermission({ roleId: approverId, permissionId: permId }, admin);
    assert.equal(row.roleId, approverId);
  }
});

test('item 1: refuses mapping formula:formula_access_policy:write onto a non-vault_approver role', async () => {
  const someRoleId = await makeRole('floor2');
  const permId = await findOrMakeExactPermission('formula:formula_access_policy:write');
  const admin = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:role_permission_mapping:write'] });
  await assert.rejects(() => svc.createRolePermission({ roleId: someRoleId, permissionId: permId }, admin));
});

test('item 1: refuses mapping platformops:console:read onto a role that is not platform_super_admin', async () => {
  const ownerRoleId = await makeRole('owner2');
  const permId = await makePermission('platformops:console:read');
  const admin = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:role_permission_mapping:write'] });
  await assert.rejects(() => svc.createRolePermission({ roleId: ownerRoleId, permissionId: permId }, admin));
});

test('item 1: an ORDINARY permission mapping is unaffected (not swept up by the guard)', async () => {
  const roleId = await makeRole('someop');
  const permId = await makePermission('inventory:rm_batch_master:read');
  const admin = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:role_permission_mapping:write'] });
  const row = await svc.createRolePermission({ roleId, permissionId: permId }, admin);
  assert.equal(row.roleId, roleId);
  assert.equal(row.permissionId, permId);
});

test('item 1: the hard allow-list itself still works — formula:actual:read DOES map onto vault_approver', async () => {
  const vaultApproverRoleId = await findOrMakeRoleByCode('vault_approver');
  const permId = await makePermission('formula:actual:read');
  const admin = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:role_permission_mapping:write'] });
  const row = await svc.createRolePermission({ roleId: vaultApproverRoleId, permissionId: permId }, admin);
  assert.equal(row.roleId, vaultApproverRoleId);
});

/* ── item 6: vault-authority role assignment exception ──────────────────────────────────── */

test('item 6: owner CAN assign the formulator role to another user, despite holding none of its permissions', async () => {
  audits = [];
  const formulatorRoleId = await findOrMakeRoleByCode('formulator');
  const grantee = await makeUser('grantee');
  // owner explicitly does NOT hold formula:actual:read or any formula:* permission (§107) —
  // this principal proves that fact doesn't block the assignment.
  const owner = principal({ userId: uuidv7(), roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });

  const row = await svc.createUserRole({ userId: grantee, roleId: formulatorRoleId }, owner);
  assert.equal(row.userId, grantee);
  assert.equal(row.roleId, formulatorRoleId);
  assert.equal(audits.length, 1, 'the assignment must be audited');
  assert.equal(audits[0]!.action, 'security.vault_role.assigned');
  assert.equal(audits[0]!.result, 'allow');
});

test('item 6: owner is REFUSED assigning formulator to THEMSELVES (no self-assignment of a Vault-authority role)', async () => {
  const formulatorRoleId = await findOrMakeRoleByCode('formulator');
  const ownerUserId = uuidv7();
  const owner = principal({ userId: ownerUserId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });

  await assert.rejects(
    () => svc.createUserRole({ userId: ownerUserId, roleId: formulatorRoleId }, owner),
    (err: any) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /cannot assign yourself/i);
      return true;
    },
  );
});

test('item 6: a role that is neither owner nor admin cannot assign vault_approver (even if it somehow held the grant permission)', async () => {
  const vaultApproverRoleId = await findOrMakeRoleByCode('vault_approver');
  const grantee = await makeUser('grantee2');
  const notOwnerOrAdmin = principal({ userId: uuidv7(), roles: ['qc'], permissions: ['iam:user_role_mapping:write'] });

  await assert.rejects(
    () => svc.createUserRole({ userId: grantee, roleId: vaultApproverRoleId }, notOwnerOrAdmin),
    (err: any) => {
      assert.equal(err.status, 403);
      return true;
    },
  );
});

test('item 6: the ordinary subset rule still applies to every OTHER role (unaffected by the exception)', async () => {
  const qcPermId = await makePermission('quality:qc_inspections:write');
  const qcRoleId = await makeRole('qcx');
  await db.insert(orgSchema.rolePermissionMapping).values({
    rolePermissionMappingId: uuidv7(),
    roleId: qcRoleId,
    permissionId: qcPermId,
    status: 'ACTIVE',
    createdBy: 'test',
    updatedBy: 'test',
  });
  const grantee = await makeUser('grantee3');
  // admin does NOT hold quality:qc_inspections:write — the ordinary subset check must still
  // refuse this (qc is not a Vault-authority role, so gets no exception).
  const admin = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:user_role_mapping:write'] });

  await assert.rejects(() => svc.createUserRole({ userId: grantee, roleId: qcRoleId }, admin));
});
