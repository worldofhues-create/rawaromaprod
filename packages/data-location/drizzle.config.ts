import { defineConfig } from "drizzle-kit";

/** drizzle-kit config for the location (sites + warehouse hierarchy) schema. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["location"],
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/raw_aroma",
  },
  verbose: true,
  strict: true,
});
