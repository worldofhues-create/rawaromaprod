import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the iam cluster.
 *
 * - `schemaFilter: ["iam"]` so generate/introspect only ever touches this cluster's
 *   schema — never another cluster's (schema-per-cluster isolation, doc 10 §1).
 * - migrations land in `./drizzle` (committed; forward-only).
 * - DATABASE_URL is supplied by nt-infra at run time (per-cluster `iam` role). It is
 *   NOT required for `drizzle-kit generate`, which is purely static analysis.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["iam"],
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/namasthethu",
  },
  verbose: true,
  strict: true,
});
