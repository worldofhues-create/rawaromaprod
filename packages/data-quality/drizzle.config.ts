import { defineConfig } from "drizzle-kit";

/** drizzle-kit config for the quality cluster. `schemaFilter: ["quality"]` scopes
 * generate/introspect to this cluster only (data-conventions §1). */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["quality"],
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/raw_aroma",
  },
  verbose: true,
  strict: true,
});
