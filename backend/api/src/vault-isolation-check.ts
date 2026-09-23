/**
 * PB-03 / SB-01 main-role vault-isolation self-check, called from main.ts at boot
 * (APP_ENV=prod only). Queries the two crown-jewel formula tables (wrapped DEK + sealed
 * ingredient ciphertext) through the MAIN app's own `PG_CLIENT` connection — the exact
 * role/connection every non-vault cluster reads through. The healthy outcome is that BOTH
 * reads are refused (permission denied, or the `formula` schema/table isn't even visible from
 * this role/connection at all — e.g. a fully separate vault_prod database per the AWS target
 * topology). `formula.formula_master`/`formula_version`/`formula_event_hist` are DELIBERATELY
 * left readable by the main role (dashboards + traceability, VAULT_HARDENING.md §3) and are
 * NOT checked here — only the two tables that actually hold recoverable secret material.
 *
 * Kept in its own module (not inline in main.ts) so it can be unit-tested against a real
 * Postgres connection without importing main.ts itself, which calls `bootstrap()` — and
 * therefore stands up a whole Nest app / listens on a port — as an unconditional side effect
 * of module load.
 */
import { Logger } from '@nestjs/common';

/** The minimal shape used here — a real postgres-js `Sql` satisfies it, and so does a test
 * double, without pulling the full `postgres` type into every caller. */
export interface UnsafeSqlClient {
  unsafe(query: string): Promise<unknown>;
}

export const VAULT_CROWN_JEWEL_TABLES = ['formula.formula_vault', 'formula.formula_ingredients'] as const;

export async function assertMainRoleCannotReadVault(pgClient: UnsafeSqlClient): Promise<void> {
  const logger = new Logger('Bootstrap');
  const leaks: string[] = [];
  for (const table of VAULT_CROWN_JEWEL_TABLES) {
    try {
      await pgClient.unsafe(`select 1 from ${table} limit 1`);
      // Reaching here means the query SUCCEEDED — the main role CAN read this table. That is
      // the isolation wall being down, not a healthy "no rows" empty-table result (LIMIT 1
      // succeeding on an empty table is still a successful read).
      leaks.push(table);
    } catch {
      // Expected: permission denied / relation does not exist from this role's search_path /
      // schema not present on this connection at all. Any of these means the wall holds.
    }
  }
  if (leaks.length > 0) {
    throw new Error(
      `Vault isolation violated: the main RawProd DB role can read ${leaks.join(', ')}. Run ` +
        'scripts/provision-vault-isolation.sql (pointing FORMULA_DATABASE_URL at the ra_vault ' +
        'role BEFORE revoking the main role, per the script\'s ORDER OF OPERATIONS) before ' +
        'deploying to production. Refusing to boot with the wall down (V4 §109.1, SB-01).',
    );
  }
  logger.log('vault isolation self-check OK — main DB role cannot read formula_vault/formula_ingredients');
}
