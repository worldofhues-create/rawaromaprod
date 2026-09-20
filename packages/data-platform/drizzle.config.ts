import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the platform cluster. `schemaFilter: ["platform"]` keeps
 * generate/introspect scoped to this cluster only (doc 10 §1). DATABASE_URL is
 * supplied by nt-infra at run time (per-cluster `platform` role); not needed for
 * `drizzle-kit generate`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["platform"],
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/namasthethu",
  },
  verbose: true,
  strict: true,
});
