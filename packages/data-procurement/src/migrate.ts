/**
 * procurement migration entry — forward-only (data-conventions §1). Tracks its own
 * `__migrations_procurement` high-water-mark. Run via `pnpm --filter @ra/data-procurement
 * migrate`. Requires DATABASE_URL.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROCUREMENT_PREREQUISITES: string[] = [
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  UUIDV7_SQL,
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run procurement migrations");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, PROCUREMENT_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_procurement");
    // eslint-disable-next-line no-console
    console.log("[procurement migrate] done");
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
