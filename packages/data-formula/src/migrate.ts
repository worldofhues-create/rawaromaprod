/**
 * formula (vault) migration entry — forward-only. Tracks its own `__migrations_formula`.
 * Runs against FORMULA_DATABASE_URL (the vault's own role) when set, else DATABASE_URL.
 * After migrating, infra applies `REVOKE UPDATE, DELETE ON formula.audit_events` and
 * `REVOKE ALL ON SCHEMA formula FROM ra_app` (the append-only + role-isolation grants).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { UUIDV7_SQL, ensurePrerequisites, runMigrations } from "@core/data-kernel";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FORMULA_PREREQUISITES: string[] = [UUIDV7_SQL];

async function main(): Promise<void> {
  const url = process.env.FORMULA_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("FORMULA_DATABASE_URL (or DATABASE_URL) is required to run vault migrations");
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    await ensurePrerequisites(db, FORMULA_PREREQUISITES);
    await runMigrations(db, resolve(__dirname, "../drizzle"), "__migrations_formula");
    // eslint-disable-next-line no-console
    console.log("[formula migrate] done");
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
