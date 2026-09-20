/**
 * Formula vault DB token — UNLIKE the other @ra clusters, the vault does NOT share the app's
 * `PG_CLIENT` pool. It opens its OWN postgres-js connection from `FORMULA_DATABASE_URL`
 * (its own `ra_vault` role; falls back to `DATABASE_URL` in Phase-1 single-Neon). That is the
 * role-isolation wall — a SQL flaw in any other cluster runs as the app role, which cannot
 * read the `formula` schema — AND the in-house-extraction seam: point FORMULA_DATABASE_URL at
 * the on-prem DB later, no code change. The pool is closed on shutdown by FormulaModule.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { ConfigService } from '@core/backend-kernel';
import * as formulaSchema from '@ra/data-formula';

/** DI token for the vault's OWN postgres-js connection (separate from PG_CLIENT). */
export const FORMULA_PG_CLIENT = Symbol('FORMULA_PG_CLIENT');

/** DI token for the vault's Drizzle client, typed to the formula schema. */
export const FORMULA_DB = Symbol('FORMULA_DB');

/** The vault's Drizzle client, typed to the formula schema. */
export type FormulaDb = PostgresJsDatabase<typeof formulaSchema>;

/** Factory: open the dedicated vault connection (own role / own URL). */
export function createFormulaClient(config: ConfigService): Sql {
  const url = config.get('FORMULA_DATABASE_URL') ?? config.get('DATABASE_URL');
  return postgres(url, { max: 5, types: {} });
}

export { drizzle, formulaSchema };
