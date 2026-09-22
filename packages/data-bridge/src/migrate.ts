/**
 * bridge migration entry — forward-only (data-conventions §1). Tracks its own
 * `__migrations_bridge` high-water-mark. Run via `pnpm --filter @ra/data-bridge migrate`.
 * Requires DATABASE_URL.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const BRIDGE_PREREQUISITES: string[] = [UUIDV7_SQL];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run bridge migrations");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, BRIDGE_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_bridge");
    // eslint-disable-next-line no-console
    console.log("[bridge migrate] done");
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
