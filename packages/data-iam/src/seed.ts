/**
 * iam seed entry — idempotent (doc 10 §1).
 *
 * Run via `pnpm --filter @core/data-iam seed`. Requires DATABASE_URL (iam role).
 * Uses ON CONFLICT DO NOTHING keyed on stable `key` columns, so re-running is a
 * no-op. Roles + permissions seed in ALL envs.
 */
import { pathToFileURL } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type SeedStep, resolveEnv, runSeeds } from "@core/data-kernel";
import { permissions, rolePermissions, roles } from "./schema/index.js";
import {
  DEFAULT_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  STARTER_PERMISSIONS,
} from "./seeds/roles.js";

export const iamSeedSteps: SeedStep[] = [
  {
    name: "iam: default roles",
    run: async (db) => {
      await db
        .insert(roles)
        .values(DEFAULT_ROLES.map((r) => ({ ...r })))
        .onConflictDoNothing({ target: roles.key });
    },
  },
  {
    name: "iam: starter permissions",
    run: async (db) => {
      await db
        .insert(permissions)
        .values(STARTER_PERMISSIONS.map((p) => ({ ...p })))
        .onConflictDoNothing({ target: permissions.key });
    },
  },
  {
    name: "iam: default role-permission grants",
    run: async (db) => {
      // Resolve keys → ids via the query builder (driver-safe `IN (...)`), then
      // insert join rows idempotently.
      for (const grant of DEFAULT_ROLE_PERMISSIONS) {
        const role = (
          await db.select({ id: roles.id }).from(roles).where(eq(roles.key, grant.roleKey))
        )[0];
        if (!role) continue;
        const perms = await db
          .select({ id: permissions.id })
          .from(permissions)
          .where(inArray(permissions.key, grant.permissionKeys));
        if (perms.length === 0) continue;
        await db
          .insert(rolePermissions)
          .values(perms.map((p) => ({ roleId: role.id, permissionId: p.id })))
          .onConflictDoNothing();
      }
    },
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run iam seeds");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema: { roles, permissions, rolePermissions } });
  try {
    const env = resolveEnv();
    const results = await runSeeds(db, iamSeedSteps, env);
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`[iam seed] ${r.status.padEnd(7)} ${r.name}`);
    }
  } finally {
    await client.end();
  }
}

// Run only when invoked directly (not when imported for the step list).
// pathToFileURL makes this correct on Windows (drive letter + backslashes) too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
