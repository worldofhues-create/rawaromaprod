/**
 * masterdata migration entry — forward-only (data-conventions §1).
 *
 * Run via `pnpm --filter @ra/data-masterdata migrate`. Requires DATABASE_URL.
 * Prereq: the uuidv7() fn + pg_trgm (name search). In a full deploy data-iam installs
 * these first; masterdata repeats the idempotent statements so it is runnable standalone.
 * Tracks its own `__migrations_masterdata` high-water-mark (never shared — a shared
 * tracking table causes silent skips across clusters).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** DDL that must exist before any masterdata migration runs. Idempotent. */
export const MASTERDATA_PREREQUISITES: string[] = [
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  UUIDV7_SQL,
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run masterdata migrations");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, MASTERDATA_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_masterdata");
    // eslint-disable-next-line no-console
    console.log("[masterdata migrate] done");
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
