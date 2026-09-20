/**
 * platform migration entry — forward-only (doc 10 §1).
 *
 * Run via `pnpm --filter @core/data-platform migrate`. Requires DATABASE_URL.
 * Prerequisites: PostGIS (geo columns) + pg_trgm (name search) + the uuidv7() fn.
 * In a full deploy the iam package installs uuidv7()/pg_trgm first; platform repeats
 * the IF NOT EXISTS / CREATE OR REPLACE statements so it is also runnable standalone.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** DDL that must exist before any platform migration runs. Idempotent. */
export const PLATFORM_PREREQUISITES: string[] = [
  "CREATE EXTENSION IF NOT EXISTS postgis",
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  UUIDV7_SQL,
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run platform migrations");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, PLATFORM_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_platform");
    // eslint-disable-next-line no-console
    console.log("[platform migrate] done");
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
