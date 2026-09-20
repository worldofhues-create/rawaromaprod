/**
 * The `formula` Postgres schema handle — the Formula Vault (M07, the crown jewel).
 *
 * Owned by its OWN PG role (`ra_vault`); the app role has NO grant here, so no hand-written
 * query from any other cluster can read it. Zero cross-schema FK (the production order
 * references a formula version by id + hash only) → this schema is the self-contained
 * in-house extraction unit. Real ingredient name/%/secret live here, ENVELOPE-ENCRYPTED.
 */
import { pgSchema } from "drizzle-orm/pg-core";

export const formula = pgSchema("formula");
