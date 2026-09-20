/**
 * Go-live bootstrap seed — makes the API usable after db:push. Idempotent (safe to re-run).
 * Run:
 *   DATABASE_URL=postgres://... BOOTSTRAP_OWNER_PASSWORD='…' \
 *     [BOOTSTRAP_FLOOR_PASSWORD=… BOOTSTRAP_QC_PASSWORD=… BOOTSTRAP_PROCUREMENT_PASSWORD=…] pnpm db:seed
 *
 * Seeds, in the iam schema:
 *   1. permission_master       — every 'cluster:table:action' the controllers guard (RA_PERMISSIONS).
 *   2. role_master             — owner + floor + qc + procurement (scripts/ra-roles.ts).
 *   3. role_permission_mapping — each role granted its own subset (RoleDef.select). HARD INVARIANT:
 *      only `owner` may hold `formula:actual:read` — the seed throws if any other role's grant
 *      would include it (the production floor must never reach the decrypted recipe).
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
  OWNER_ONLY_PERMISSION,
  ROLE_GRANT_PERMISSION,
  ROLE_GRANTERS,
  CAPABILITY_PERMISSIONS,
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
  // HARD INVARIANT: only owner may hold the decrypted-recipe permission.
  if (role.code !== 'owner' && granted.some((p) => p.code === OWNER_ONLY_PERMISSION)) {
    throw new Error(`SECURITY: role '${role.code}' must not be granted ${OWNER_ONLY_PERMISSION}`);
  }
  // HARD INVARIANT: only owner + admin may GRANT roles. "Only an admin can give the role."
  if (!ROLE_GRANTERS.includes(role.code) && granted.some((p) => p.code === ROLE_GRANT_PERMISSION)) {
    throw new Error(`SECURITY: role '${role.code}' must not be granted ${ROLE_GRANT_PERMISSION} (role-granting is admin-only)`);
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
      console.log(`role '${role.code}': holds ${count} perms${role.code === 'owner' ? ' (ALL incl formula:actual:read)' : ''}`);

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
