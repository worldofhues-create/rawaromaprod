/**
 * location migration entry — forward-only. Tracks `__migrations_location`. Sites + warehouse
 * hierarchy (warehouse→floor→zone→rack→shelf→bin) + storage locations for Phase-1A.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const LOCATION_PREREQUISITES: string[] = [UUIDV7_SQL];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run location migrations");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, LOCATION_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_location");
    // eslint-disable-next-line no-console
    console.log("[location migrate] done");
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
