import { defineConfig } from "drizzle-kit";

/** drizzle-kit config for the Formula Vault. `schemaFilter: ["formula"]` scopes it. The
 * vault migrates against FORMULA_DATABASE_URL (its own role) in prod; DATABASE_URL here is
 * just the generate-time default. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["formula"],
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.FORMULA_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgres://localhost:5432/raw_aroma",
  },
  verbose: true,
  strict: true,
});
