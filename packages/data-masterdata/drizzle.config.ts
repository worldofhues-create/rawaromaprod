import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the masterdata cluster. `schemaFilter: ["masterdata"]` keeps
 * generate/introspect scoped to this cluster only (data-conventions §1). DATABASE_URL
 * is supplied at run time (per-cluster role); not needed for `drizzle-kit generate`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["masterdata"],
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/raw_aroma",
  },
  verbose: true,
  strict: true,
});
