/**
 * Migration + seed runners (doc 10 §1 "Migrations & seeds").
 *
 * Thin, domain-free helpers each `@core/data-<cluster>` package wires up. They wrap
 * drizzle-orm primitives so a cluster's `migrate.ts` / `seed.ts` are one-liners and
 * behave identically everywhere: forward-only migrations, idempotent env-aware seeds.
 *
 * These are STUBS in the sense that the actual connection is provided by the caller
 * (nt-infra owns connection strings / per-cluster roles). They contain real, working
 * logic — not placeholders — but do not open a connection themselves.
 */
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * A postgres-js Drizzle handle, schema-agnostic. The runner only uses schema-free
 * surface (`.execute()`, and hands the db to drizzle's `migrate`), so we accept any
 * concrete schema generic — a `drizzle(client, { schema })` instance with a specific
 * schema is assignable here (the `<any>` avoids generic-invariance friction).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PostgresJsDatabase<any>;

export type Env = "dev" | "staging" | "prod";

/** Resolve the current environment from NODE_ENV/APP_ENV (defaults to dev). */
export function resolveEnv(): Env {
  const raw = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "dev").toLowerCase();
  if (raw.startsWith("prod")) return "prod";
  if (raw.startsWith("stag")) return "staging";
  return "dev";
}

/**
 * Run a cluster's forward-only migration set from its `drizzle/` folder.
 *
 * Each cluster MUST track its own migration state in its OWN table — drizzle's migrator
 * applies migrations by a single high-water-mark timestamp, so if N clusters shared one
 * `__drizzle_migrations` table the cluster with the lower journal `when` would be silently
 * skipped. Passing a per-cluster `migrationsTable` keeps clusters independent (and matches
 * the schema-per-cluster / extraction-safe design). The migrator stays idempotent.
 *
 * @param db drizzle db bound to the cluster's schema/role.
 * @param migrationsFolder absolute path to the package's `drizzle/` output.
 * @param migrationsTable per-cluster tracking table, e.g. `__migrations_iam`.
 */
export async function runMigrations(
  db: Db,
  migrationsFolder: string,
  migrationsTable: string,
): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsTable });
}

/**
 * Install the `uuidv7()` SQL function (and any other prerequisite DDL) before the
 * first migration runs. Idempotent (CREATE OR REPLACE). Call from the kernel's
 * bootstrap or the iam migration entry. The SQL itself lives in `uuid.ts`.
 */
export async function ensurePrerequisites(
  db: Db,
  statements: string[],
): Promise<void> {
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

/**
 * A single idempotent seed step. `run` receives the db + env; the runner guarantees
 * `skip` short-circuits and logs are uniform. Seeds MUST be written with
 * `ON CONFLICT DO NOTHING` / upserts so re-running is a no-op (doc 10 §1).
 */
export interface SeedStep {
  name: string;
  /** env gate — omit to run in all envs (masters/geo/roles always). */
  envs?: Env[];
  run: (db: Db, env: Env) => Promise<void>;
}

export interface SeedResult {
  name: string;
  status: "ran" | "skipped";
}

/**
 * Run an ordered list of idempotent seed steps, honouring per-step env gates.
 * Returns a per-step report (handy for CI logs). Throws on first failure so a
 * broken seed never half-applies silently.
 */
export async function runSeeds(
  db: Db,
  steps: SeedStep[],
  env: Env = resolveEnv(),
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const step of steps) {
    if (step.envs && !step.envs.includes(env)) {
      results.push({ name: step.name, status: "skipped" });
      continue;
    }
    await step.run(db, env);
    results.push({ name: step.name, status: "ran" });
  }
  return results;
}
