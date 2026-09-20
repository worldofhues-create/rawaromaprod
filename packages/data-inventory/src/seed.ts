/**
 * inventory seed entry — idempotent (data-conventions §1). The inventory cluster has no
 * static reference data of its own (movement types / batch statuses are enum strings, not
 * seeded rows); the steps list is intentionally empty so the runner is a no-op but the
 * `seed` script stays uniform across clusters. Run via `pnpm --filter @ra/data-inventory seed`.
 */
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type SeedStep, resolveEnv, runSeeds } from "@core/data-kernel";

export const inventorySeedSteps: SeedStep[] = [];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run inventory seeds");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const env = resolveEnv();
    const results = await runSeeds(db, inventorySeedSteps, env);
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`[inventory seed] ${r.status.padEnd(7)} ${r.name}`);
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
