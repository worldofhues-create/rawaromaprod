/**
 * iam migration entry — forward-only (doc 10 §1).
 *
 * Run via `pnpm --filter @core/data-iam migrate`. Requires DATABASE_URL.
 * Installs prerequisites (uuidv7() fn, pg_trgm, citext-not-needed) then applies the
 * committed migration set in `./drizzle`. The iam package owns the `uuidv7()` install
 * + pg_trgm because it is the FIRST cluster in build order — platform/property assume
 * they already exist.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** DDL that must exist before any iam migration runs. Idempotent. */
export const IAM_PREREQUISITES: string[] = [
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  UUIDV7_SQL,
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run iam migrations");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, IAM_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_iam");
    // eslint-disable-next-line no-console
    console.log("[iam migrate] done");
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
