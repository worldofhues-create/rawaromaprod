/**
 * masterdata seed entry — idempotent (data-conventions §1).
 *
 * Run via `pnpm --filter @ra/data-masterdata seed`. Requires DATABASE_URL. The Phase-1A
 * Data Dictionary defines no fixed seed rows for the masterdata material tables (material
 * classification + masters are operator-entered, not enum lists), so there are currently
 * no seed steps. Kept as a valid no-op so the migrate-all runner's seed phase stays green.
 */
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type SeedStep, resolveEnv, runSeeds } from "@core/data-kernel";

export const masterdataSeedSteps: SeedStep[] = [];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run masterdata seeds");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const env = resolveEnv();
    const results = await runSeeds(db, masterdataSeedSteps, env);
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`[masterdata seed] ${r.status.padEnd(7)} ${r.name}`);
    }
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
