/**
 * Go-live bootstrap seed — makes the API usable after db:push. Idempotent (safe to re-run).
 * Run:
 *   DATABASE_URL=postgres://... BOOTSTRAP_OWNER_PASSWORD='…' \
 *     [BOOTSTRAP_FLOOR_PASSWORD=… BOOTSTRAP_QC_PASSWORD=… BOOTSTRAP_PROCUREMENT_PASSWORD=…] pnpm db:seed
 *
 * Seeds, in the iam schema:
 *   1. permission_master       — every 'cluster:table:action' the controllers guard (RA_PERMISSIONS).
 *   2. role_master             — owner + floor + qc + procurement (scripts/ra-roles.ts).
 *   3. role_permission_mapping — each role granted its own subset (RoleDef.select). HARD INVARIANT
 *      (§107): only `formulator`/`vault_approver` may hold `formula:actual:read` — the seed
 *      throws if any other role's grant (owner/admin/platform_super_admin/production/…included)
 *      would include it. Vault authority is a separate grant, never implicit.
 *   4. user_master             — one Argon2id sample login per role whose password env is set.
 *   5. user_role_mapping       — each sample user → its role.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import argon2 from 'argon2';
import { uuidv7 } from '@core/data-kernel';
import * as orgSchema from '@ra/data-org';
import { RA_PERMISSIONS } from './ra-permissions.js';
import {
  ROLES,
  VAULT_PLAINTEXT_PERMISSION,
  VAULT_PLAINTEXT_ROLES,
  PLATFORM_OPS_PERMISSION,
  PLATFORM_OPS_ROLES,
  ROLE_GRANT_PERMISSION,
  ROLE_GRANTERS,
  CAPABILITY_PERMISSIONS,
  FORMULA_DECISION_PERMISSIONS,
  FORMULATOR_FORBIDDEN_PERMISSIONS,
  VAULT_APPROVER_FORBIDDEN_PERMISSIONS,
  MANUFACTURING_INSTRUCTION_PERMISSION,
  MANUFACTURING_INSTRUCTION_ROLES,
  MANUAL_CONTINUITY_PERMISSION,
  MANUAL_CONTINUITY_ROLES,
  type RoleDef,
} from './ra-roles.js';

/** Route-guarded perms + non-route capability perms, both seeded into permission_master. */
const ALL_PERMISSION_CODES = [...RA_PERMISSIONS, ...CAPABILITY_PERMISSIONS];

const { permissionMaster, roleMaster, rolePermissionMapping, userMaster, userRoleMapping } = orgSchema;

type Db = ReturnType<typeof drizzle>;

async function upsertRole(db: Db, role: RoleDef): Promise<string> {
  const existing = (
    await db.select().from(roleMaster).where(eq(roleMaster.roleCode, role.code)).limit(1)
  )[0];
  if (existing) return existing.roleId;
  const inserted = (
    await db
      .insert(roleMaster)
      .values({
        roleId: uuidv7(),
        roleCode: role.code,
        roleName: role.name,
        status: 'ACTIVE',
        createdBy: 'system',
        updatedBy: 'system',
      })
      .returning()
  )[0];
  if (!inserted) throw new Error(`failed to upsert role ${role.code}`);
  return inserted.roleId;
}

async function grantRole(
  db: Db,
  role: RoleDef,
  roleId: string,
  allPerms: { id: string; code: string }[],
): Promise<number> {
  const granted = allPerms.filter((p) => role.select(p.code));
  // HARD INVARIANT (§107): only formulator/vault_approver may hold the decrypted-recipe
  // permission — NOT owner/admin/platform_super_admin. Vault authority is a separate grant.
  if (!VAULT_PLAINTEXT_ROLES.includes(role.code) && granted.some((p) => p.code === VAULT_PLAINTEXT_PERMISSION)) {
    throw new Error(
      `SECURITY: role '${role.code}' must not be granted ${VAULT_PLAINTEXT_PERMISSION} — only ${VAULT_PLAINTEXT_ROLES.join('/')} may hold Vault plaintext access (§107)`,
    );
  }
  // HARD INVARIANT (§113): only platform_super_admin may hold the Platform Ops console
  // permission — NOT owner (whose blanket grant excludes it explicitly) or any other role.
  if (!PLATFORM_OPS_ROLES.includes(role.code) && granted.some((p) => p.code === PLATFORM_OPS_PERMISSION)) {
    throw new Error(
      `SECURITY: role '${role.code}' must not be granted ${PLATFORM_OPS_PERMISSION} — only ${PLATFORM_OPS_ROLES.join('/')} may hold Platform Ops access (§113)`,
    );
  }
  // HARD INVARIANT: only owner + admin may GRANT roles. "Only an admin can give the role."
  if (!ROLE_GRANTERS.includes(role.code) && granted.some((p) => p.code === ROLE_GRANT_PERMISSION)) {
    throw new Error(`SECURITY: role '${role.code}' must not be granted ${ROLE_GRANT_PERMISSION} (role-granting is admin-only)`);
  }
  // HARD INVARIANT (§107/§108, security review item 2): no role outside
  // formulator/vault_approver may hold ANY formula-decision (drafting/seal/approve/lock/
  // access-policy/copy-request) WRITE permission — `owner` included. See
  // FORMULA_DECISION_PERMISSIONS's doc comment in scripts/ra-roles.ts.
  if (!VAULT_PLAINTEXT_ROLES.includes(role.code)) {
    const offending = granted.filter((p) => FORMULA_DECISION_PERMISSIONS.has(p.code));
    if (offending.length) {
      throw new Error(
        `SECURITY: role '${role.code}' must not be granted formula-decision permission(s) [${offending.map((p) => p.code).join(', ')}] — only ${VAULT_PLAINTEXT_ROLES.join('/')} may hold Vault-authority decision permissions (§107/§108)`,
      );
    }
  }
  // HARD INVARIANT (§108 SoD, security review item 2): formulator (drafting) never holds an
  // approve/lock/access-policy DECISION permission; vault_approver (review/decision) never
  // holds a drafting/seal WRITE permission. "Approve/reject/lock require vault_approver-only
  // perms; drafting requires formulator perms" — made explicit here, not just implicit in
  // each role's `select` predicate.
  if (role.code === 'formulator') {
    const offending = granted.filter((p) => FORMULATOR_FORBIDDEN_PERMISSIONS.has(p.code));
    if (offending.length) {
      throw new Error(
        `SECURITY: role 'formulator' must not be granted approval-decision permission(s) [${offending.map((p) => p.code).join(', ')}] — SoD complement of vault_approver (§108)`,
      );
    }
  }
  if (role.code === 'vault_approver') {
    const offending = granted.filter((p) => VAULT_APPROVER_FORBIDDEN_PERMISSIONS.has(p.code));
    if (offending.length) {
      throw new Error(
        `SECURITY: role 'vault_approver' must not be granted drafting/seal permission(s) [${offending.map((p) => p.code).join(', ')}] — SoD complement of formulator (§108)`,
      );
    }
  }
  // HARD INVARIANT (§109.7, security review item 4): the manufacturing-instruction read is
  // held ONLY by production + compounding — owner, filling, and everyone else refused,
  // including via owner's otherwise-blanket grant.
  if (!MANUFACTURING_INSTRUCTION_ROLES.includes(role.code) && granted.some((p) => p.code === MANUFACTURING_INSTRUCTION_PERMISSION)) {
    throw new Error(
      `SECURITY: role '${role.code}' must not be granted ${MANUFACTURING_INSTRUCTION_PERMISSION} — only ${MANUFACTURING_INSTRUCTION_ROLES.join('/')} may hold it (§109.7)`,
    );
  }
  // HARD INVARIANT (G1/PB-08, FINAL_OS §2.3/§41): the sales manual-continuity break-glass
  // permission is held ONLY by owner/admin — no factory/sales role, ever.
  if (!MANUAL_CONTINUITY_ROLES.includes(role.code) && granted.some((p) => p.code === MANUAL_CONTINUITY_PERMISSION)) {
    throw new Error(
      `SECURITY: role '${role.code}' must not be granted ${MANUAL_CONTINUITY_PERMISSION} — only ${MANUAL_CONTINUITY_ROLES.join('/')} may hold it (G1/PB-08)`,
    );
  }
  const mapped = await db
    .select({ pid: rolePermissionMapping.permissionId })
    .from(rolePermissionMapping)
    .where(eq(rolePermissionMapping.roleId, roleId));
  const mappedSet = new Set(mapped.map((m) => m.pid));
  const toGrant = granted.filter((p) => !mappedSet.has(p.id));
  if (toGrant.length) {
    await db.insert(rolePermissionMapping).values(
      toGrant.map((p) => ({
        rolePermissionMappingId: uuidv7(),
        roleId,
        permissionId: p.id,
        status: 'ACTIVE',
        createdBy: 'system',
        updatedBy: 'system',
      })),
    );
  }
  return granted.length;
}

async function upsertUserForRole(
  db: Db,
  role: RoleDef,
  roleId: string,
  email: string,
  password: string,
): Promise<void> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  let user = (await db.select().from(userMaster).where(eq(userMaster.email, email)).limit(1))[0];
  if (!user) {
    user = (
      await db
        .insert(userMaster)
        .values({
          userId: uuidv7(),
          userName: role.code,
          email,
          passwordHash,
          isActive: true,
          status: 'ACTIVE',
          createdBy: 'system',
          updatedBy: 'system',
        })
        .returning()
    )[0];
    // eslint-disable-next-line no-console
    console.log(`  user created: ${email} (${role.code})`);
  } else {
    await db
      .update(userMaster)
      .set({ passwordHash, isActive: true, updatedBy: 'system' })
      .where(eq(userMaster.userId, user.userId));
    // eslint-disable-next-line no-console
    console.log(`  user password reset: ${email} (${role.code})`);
  }
  if (!user) throw new Error(`failed to upsert user ${email}`);

  const urm = (
    await db
      .select()
      .from(userRoleMapping)
      .where(and(eq(userRoleMapping.userId, user.userId), eq(userRoleMapping.roleId, roleId)))
      .limit(1)
  )[0];
  if (!urm) {
    await db.insert(userRoleMapping).values({
      userRoleMappingId: uuidv7(),
      userId: user.userId,
      roleId,
      status: 'ACTIVE',
      createdBy: 'system',
      updatedBy: 'system',
    });
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to seed');
  if (!process.env.BOOTSTRAP_OWNER_PASSWORD) {
    throw new Error('BOOTSTRAP_OWNER_PASSWORD is required (the owner login password)');
  }

  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client, { schema: orgSchema });
  try {
    // 1. permission_master — insert any missing perms (idempotent by permission_code).
    const existing = await db.select({ code: permissionMaster.permissionCode }).from(permissionMaster);
    const have = new Set(existing.map((r) => r.code));
    const missing = ALL_PERMISSION_CODES.filter((p) => !have.has(p));
    if (missing.length) {
      await db.insert(permissionMaster).values(
        missing.map((p) => ({
          permissionId: uuidv7(),
          permissionCode: p,
          permissionName: p,
          moduleName: p.split(':')[0] ?? p,
          status: 'ACTIVE',
          createdBy: 'system',
          updatedBy: 'system',
        })),
      );
    }
    // eslint-disable-next-line no-console
    console.log(`permissions: ${ALL_PERMISSION_CODES.length} total, ${missing.length} newly inserted`);

    const allPerms = await db
      .select({ id: permissionMaster.permissionId, code: permissionMaster.permissionCode })
      .from(permissionMaster);

    // 2–5. roles + grants (+ sample users where a password env is provided).
    for (const role of ROLES) {
      const roleId = await upsertRole(db, role);
      const count = await grantRole(db, role, roleId, allPerms);
      // eslint-disable-next-line no-console
      console.log(`role '${role.code}': holds ${count} perms${VAULT_PLAINTEXT_ROLES.includes(role.code) ? ` (incl ${VAULT_PLAINTEXT_PERMISSION})` : ''}`);

      const email =
        role.code === 'owner' ? process.env.BOOTSTRAP_OWNER_EMAIL ?? role.sampleEmail : role.sampleEmail;
      const password = process.env[role.passwordEnv];
      if (password) {
        await upsertUserForRole(db, role, roleId, email, password);
      }
    }
    // eslint-disable-next-line no-console
    console.log('db:seed complete — sample users can POST /auth/login');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
