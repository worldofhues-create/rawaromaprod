/**
 * production migration entry — forward-only. Tracks `__migrations_production`. Prerequisite is
 * the shared uuidv7() function (idempotent across packages via ensurePrerequisites).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PRODUCTION_PREREQUISITES: string[] = [UUIDV7_SQL];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run production migrations");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, PRODUCTION_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_production");
    // eslint-disable-next-line no-console
    console.log("[production migrate] done");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
