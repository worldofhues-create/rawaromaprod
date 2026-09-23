/**
 * Formula vault DB token — UNLIKE the other @ra clusters, the vault does NOT share the app's
 * `PG_CLIENT` pool. It opens its OWN postgres-js connection from `FORMULA_DATABASE_URL`
 * (its own `ra_vault` role). That is the role-isolation wall — a SQL flaw in any other
 * cluster runs as the app role, which cannot read the `formula` schema — AND the
 * in-house-extraction seam: point FORMULA_DATABASE_URL at the on-prem DB later, no code
 * change. The pool is closed on shutdown by FormulaModule.
 *
 * PB-03 / V4 §109.1, §7.2: production (APP_ENV=prod) NEVER falls back to DATABASE_URL — that
 * would hand the vault's own connection the SAME role as the main app, defeating the
 * isolation wall entirely (SB-01). Falling back is a dev/CI-only convenience now.
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

/** Factory: open the dedicated vault connection (own role / own URL). Fails CLOSED (throws,
 * never silently reuses the main app connection) when APP_ENV=prod and FORMULA_DATABASE_URL
 * is unset — see the module doc above. */
export function createFormulaClient(config: ConfigService): Sql {
  const url = config.get('FORMULA_DATABASE_URL');
  if (!url) {
    if (config.get('APP_ENV') === 'prod') {
      throw new Error(
        'FORMULA_DATABASE_URL is required when APP_ENV=prod. The Formula Vault refuses to fall ' +
          'back to DATABASE_URL in production — that would share the main app DB role with the ' +
          'vault connection, defeating the ra_vault role-isolation wall (V4 §109.1, FINAL_OS §7.2, ' +
          'SB-01). Provision a dedicated ra_vault-role connection string (scripts/provision-vault-isolation.sql) first.',
      );
    }
    return postgres(config.get('DATABASE_URL'), { max: 5, types: {} });
  }
  return postgres(url, { max: 5, types: {} });
}

export { drizzle, formulaSchema };
