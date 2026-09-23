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
 *
 * S2 item A: item 6 stopped a requester self-assigning a Vault-authority role to THEIR OWN
 * account, but left the second half of the finding open — owner/admin could create a brand-new
 * (puppet) user account and hand it formulator/vault_approver instead, still with only one
 * person involved (the old self-assignment check just compared user ids). createUserRole now
 * opens a PENDING vault_role_grant_request instead of writing user_role_mapping directly; only
 * SecurityService.approveVaultRoleGrant — called by a DIFFERENT owner/admin, never the
 * requester, never the target, and never an account the requester themselves created
 * (user_master.created_by) — inserts the effective mapping and fires
 * `security.vault_role.assigned`. cancelVaultRoleGrant lets the requester withdraw a still-
 * PENDING request.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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

/** "review B"'s control assertion re-maps a FIXED (role, permission) pair every run — on a
 * reused DB (role/permission both found via the exact-code helpers above, not recreated) a
 * second `svc.createRolePermission` call for the same pair hits
 * role_permission_mapping's unique (role_id, permission_id) constraint. Idempotent
 * find-or-create, same reasoning as findOrMakeRoleByCode/findOrMakeExactPermission. */
async function findOrCreateRolePermission(roleId: string, permissionId: string, admin: ReturnType<typeof principal>) {
  const existing = (
    await db
      .select()
      .from(orgSchema.rolePermissionMapping)
      .where(and(eq(orgSchema.rolePermissionMapping.roleId, roleId), eq(orgSchema.rolePermissionMapping.permissionId, permissionId)))
      .limit(1)
  )[0];
  if (existing) return existing;
  return svc.createRolePermission({ roleId, permissionId }, admin);
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
    const row = await findOrCreateRolePermission(approverId, permId, admin);
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

/* ── item 6 / S2 item A: vault-authority role assignment is now a two-person action ──────── */

/** Insert a user row with an explicit `created_by` (the default `makeUser` always stamps
 * 'test' — the puppet-account test needs a target `created_by` value it can compare against a
 * specific requester's userId). */
async function makeUserCreatedBy(emailPrefix: string, createdBy: string): Promise<string> {
  const userId = uuidv7();
  const email = `${emailPrefix}-${sid()}@test.local`;
  await db.insert(userMaster).values({
    userId,
    userName: email,
    email,
    passwordHash: 'x',
    isActive: true,
    status: 'ACTIVE',
    createdBy,
    updatedBy: createdBy,
  });
  return userId;
}

test('item 6/A: requesting formulator opens a PENDING request — no user_role_mapping row yet (JWT perms unchanged until approved)', async () => {
  audits = [];
  const formulatorRoleId = await findOrMakeRoleByCode('formulator');
  const grantee = await makeUser('grantee');
  const ownerId = uuidv7();
  // owner explicitly does NOT hold formula:actual:read or any formula:* permission (§107) —
  // this principal proves that fact doesn't block opening the request.
  const owner = principal({ userId: ownerId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });

  const request = await svc.createUserRole({ userId: grantee, roleId: formulatorRoleId }, owner);
  assert.equal((request as any).grantStatus, 'PENDING');
  assert.equal(request.userId, grantee);
  assert.equal(request.roleId, formulatorRoleId);
  assert.equal(audits.length, 1, 'the request must be audited');
  assert.equal(audits[0]!.action, 'security.vault_role.requested');
  assert.equal(audits[0]!.result, 'allow');

  const mapping = await db
    .select()
    .from(orgSchema.userRoleMapping)
    .where(eq(orgSchema.userRoleMapping.userId, grantee));
  assert.equal(mapping.length, 0, 'the mapping must not exist — the request alone has no effect');
});

test('item 6: owner is REFUSED requesting formulator for THEMSELVES (no self-assignment of a Vault-authority role)', async () => {
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

test('item 6: a role that is neither owner nor admin cannot request vault_approver (even if it somehow held the grant permission)', async () => {
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

test('item A: requester cannot approve their own request', async () => {
  const vaultApproverRoleId = await findOrMakeRoleByCode('vault_approver');
  const grantee = await makeUser('grantee-selfapprove');
  const ownerId = uuidv7();
  const owner = principal({ userId: ownerId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });
  const request = await svc.createUserRole({ userId: grantee, roleId: vaultApproverRoleId }, owner);

  await assert.rejects(
    () => svc.approveVaultRoleGrant((request as any).vaultRoleGrantRequestId, owner),
    (err: any) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /cannot approve your own/i);
      return true;
    },
  );
});

test('item A: the target user cannot approve their own grant, even if they also hold owner/admin', async () => {
  const formulatorRoleId = await findOrMakeRoleByCode('formulator');
  const requesterId = uuidv7();
  const requester = principal({ userId: requesterId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });
  // The target is itself an existing owner being granted an ADDITIONAL vault-authority role.
  const targetId = await makeUser('target-selfapprove');
  const request = await svc.createUserRole({ userId: targetId, roleId: formulatorRoleId }, requester);

  const targetAsApprover = principal({ userId: targetId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });
  await assert.rejects(
    () => svc.approveVaultRoleGrant((request as any).vaultRoleGrantRequestId, targetAsApprover),
    (err: any) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /cannot approve their own grant/i);
      return true;
    },
  );
});

test('item A: a puppet account the requester themselves created cannot approve either', async () => {
  const formulatorRoleId = await findOrMakeRoleByCode('formulator');
  const requesterId = uuidv7();
  const requester = principal({ userId: requesterId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });
  const grantee = await makeUser('grantee-puppet');
  const request = await svc.createUserRole({ userId: grantee, roleId: formulatorRoleId }, requester);

  // The exact loophole this item closes: the requester creates a SECOND account and tries to
  // use it as the "different" approver.
  const puppetUserId = await makeUserCreatedBy('puppet-admin', requesterId);
  const puppet = principal({ userId: puppetUserId, roles: ['admin'], permissions: ['iam:user_role_mapping:write'] });

  await assert.rejects(
    () => svc.approveVaultRoleGrant((request as any).vaultRoleGrantRequestId, puppet),
    (err: any) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /created by the same person/i);
      return true;
    },
  );
});

test('item A: a genuinely different, independent owner/admin CAN approve — the mapping only takes effect now, and security.vault_role.assigned fires on activation', async () => {
  audits = [];
  const formulatorRoleId = await findOrMakeRoleByCode('formulator');
  const requesterId = uuidv7();
  const requester = principal({ userId: requesterId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });
  const grantee = await makeUser('grantee-approved');
  const request = await svc.createUserRole({ userId: grantee, roleId: formulatorRoleId }, requester);
  assert.equal(audits[0]!.action, 'security.vault_role.requested');

  const independentAdminId = await makeUserCreatedBy('indep-admin', 'someone-else-entirely');
  const independentAdmin = principal({ userId: independentAdminId, roles: ['admin'], permissions: ['iam:user_role_mapping:write'] });

  const mapping = await svc.approveVaultRoleGrant((request as any).vaultRoleGrantRequestId, independentAdmin);
  assert.equal(mapping.userId, grantee);
  assert.equal(mapping.roleId, formulatorRoleId);
  assert.equal(audits.length, 2, 'the activation must be audited too');
  assert.equal(audits[1]!.action, 'security.vault_role.assigned');
  assert.equal(audits[1]!.result, 'allow');

  const resolved = await svc.getVaultRoleGrantRequestById((request as any).vaultRoleGrantRequestId);
  assert.equal(resolved?.grantStatus, 'APPROVED');

  // Re-approving (or re-cancelling) an already-decided request is refused.
  await assert.rejects(() => svc.approveVaultRoleGrant((request as any).vaultRoleGrantRequestId, independentAdmin));
});

test('item A: an expired PENDING request cannot be approved', async () => {
  const vaultApproverRoleId = await findOrMakeRoleByCode('vault_approver');
  const requesterId = uuidv7();
  const requester = principal({ userId: requesterId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });
  const grantee = await makeUser('grantee-expired');
  const request = await svc.createUserRole({ userId: grantee, roleId: vaultApproverRoleId }, requester);

  // Simulate the 72h TTL having elapsed.
  await db
    .update(orgSchema.vaultRoleGrantRequest)
    .set({ expiresDt: new Date(Date.now() - 1000) })
    .where(eq(orgSchema.vaultRoleGrantRequest.vaultRoleGrantRequestId, (request as any).vaultRoleGrantRequestId));

  const independentAdminId = await makeUserCreatedBy('indep-admin2', 'someone-else-again');
  const independentAdmin = principal({ userId: independentAdminId, roles: ['admin'], permissions: ['iam:user_role_mapping:write'] });
  await assert.rejects(
    () => svc.approveVaultRoleGrant((request as any).vaultRoleGrantRequestId, independentAdmin),
    (err: any) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /expired/i);
      return true;
    },
  );

  const resolved = await svc.getVaultRoleGrantRequestById((request as any).vaultRoleGrantRequestId);
  assert.equal(resolved?.grantStatus, 'EXPIRED', 'the lazy expiry check must mark the request EXPIRED');

  const mapping = await db
    .select()
    .from(orgSchema.userRoleMapping)
    .where(eq(orgSchema.userRoleMapping.userId, grantee));
  assert.equal(mapping.length, 0, 'an expired request must never produce an effective mapping');
});

test('item A: requester may cancel their own PENDING request; nobody else can, and a cancelled request cannot then be approved', async () => {
  const formulatorRoleId = await findOrMakeRoleByCode('formulator');
  // cancelVaultRoleGrant writes decided_by = the requester's own id (FK'd to user_master), so
  // — unlike the createdBy-only paths above — this requester needs a real user row.
  const requesterId = await makeUser('requester-cancel');
  const requester = principal({ userId: requesterId, roles: ['owner'], permissions: ['iam:user_role_mapping:write'] });
  const grantee = await makeUser('grantee-cancel');
  const request = await svc.createUserRole({ userId: grantee, roleId: formulatorRoleId }, requester);

  const someoneElse = principal({ userId: uuidv7(), roles: ['admin'], permissions: ['iam:user_role_mapping:write'] });
  await assert.rejects(() => svc.cancelVaultRoleGrant((request as any).vaultRoleGrantRequestId, someoneElse));

  const cancelled = await svc.cancelVaultRoleGrant((request as any).vaultRoleGrantRequestId, requester);
  assert.equal(cancelled.vaultRoleGrantRequestId, (request as any).vaultRoleGrantRequestId);

  const independentAdminId = await makeUserCreatedBy('indep-admin3', 'yet-another-actor');
  const independentAdmin = principal({ userId: independentAdminId, roles: ['admin'], permissions: ['iam:user_role_mapping:write'] });
  await assert.rejects(() => svc.approveVaultRoleGrant((request as any).vaultRoleGrantRequestId, independentAdmin));
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
