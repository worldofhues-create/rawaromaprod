import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the inventory cluster. `schemaFilter: ["inventory"]` scopes
 * generate/introspect to this cluster only (data-conventions §1). DATABASE_URL is supplied
 * at run time (per-cluster role); not needed for `drizzle-kit generate`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["inventory"],
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/raw_aroma",
  },
  verbose: true,
  strict: true,
});
