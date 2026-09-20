/**
 * packaging migration entry — forward-only. Tracks `__migrations_packaging`. Cross-schema
 * references (formula/brand/location/oil_batch/product_sku) are id-only soft refs, so this
 * schema migrates independently of its upstream schemas.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PACKAGING_PREREQUISITES: string[] = [UUIDV7_SQL];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run packaging migrations");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, PACKAGING_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_packaging");
    // eslint-disable-next-line no-console
    console.log("[packaging migrate] done");
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
