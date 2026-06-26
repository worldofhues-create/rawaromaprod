import { defineConfig } from "drizzle-kit";

/** drizzle-kit config for the workflow (lightweight state engine) schema. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["workflow"],
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/raw_aroma",
  },
  verbose: true,
  strict: true,
});
