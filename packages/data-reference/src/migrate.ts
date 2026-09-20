/**
 * platform (reference masters) migration entry — forward-only. Tracks
 * `__migrations_platform`. Reference masters that the rest of the Phase-1A schemas
 * soft-ref (country/currency/timezone/language/uom/brand/document/address/etc.).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PLATFORM_PREREQUISITES: string[] = [UUIDV7_SQL];

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
