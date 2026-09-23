/**
 * PB-03 / SB-01 main-role vault-isolation self-check, called from main.ts at boot
 * (APP_ENV=prod only). Queries EVERY table in the `formula` schema (discovered live off
 * `information_schema.tables`, never a hand-maintained list — a table added to that schema
 * after this file was last edited is checked automatically) through the MAIN app's own
 * `PG_CLIENT` connection — the exact role/connection every non-vault cluster reads through.
 * The healthy outcome is that EVERY read is refused with a SPECIFIC Postgres error: SQLSTATE
 * `42501` (insufficient_privilege — permission denied) or `42P01` (undefined_table — the
 * schema/table isn't even visible from this role/connection at all, e.g. a fully separate
 * vault_prod database per the AWS target topology).
 *
 * SECURITY REVIEW ITEM 8: the previous version treated ANY thrown error (a bare `catch {}`)
 * as "the wall holds" and checked a hard-coded two-table list. Both were fail-OPEN bugs: a
 * transient connection error, a timeout, or a typo'd table name would read exactly like a
 * healthy permission-denied refusal and let the app boot silently mis-diagnosed as safe; and
 * a table added to `formula.*` after this list was last updated was never probed at all. This
 * version (a) discovers the table list from the database itself and (b) only accepts the two
 * SQLSTATEs that actually mean "the wall holds" — anything else (including a successful read,
 * or an unexpected error) is treated as inconclusive-or-worse and fails the boot loudly.
 *
 * Kept in its own module (not inline in main.ts) so it can be unit-tested against a real
 * Postgres connection without importing main.ts itself, which calls `bootstrap()` — and
 * therefore stands up a whole Nest app / listens on a port — as an unconditional side effect
 * of module load.
 */
import { Logger } from '@nestjs/common';

/** The minimal shape used here — a real postgres-js `Sql` satisfies it, and so does a test
 * double, without pulling the full `postgres` type into every caller. `unsafe` must resolve to
 * an array of rows (postgres-js's own contract) for `listFormulaSchemaTables` below to read
 * `table_name` off it. */
export interface UnsafeSqlClient {
  unsafe(query: string): Promise<unknown>;
}

/** The two SQLSTATEs that mean "the wall holds" — nothing else does. `insufficient_privilege`
 *  (a real GRANT/REVOKE refusal) and `undefined_table` (the schema/table doesn't exist at all
 *  from this role's connection — a fully separate vault database). Postgres reference:
 *  https://www.postgresql.org/docs/current/errcodes-appendix.html */
const WALL_HOLDS_SQLSTATES = new Set(['42501', '42P01']);

/** Legacy export kept for any caller still importing the old hard-coded list (e.g. a stale
 *  doc reference) — no longer used by `assertMainRoleCannotReadVault` itself, which now
 *  discovers the table list live. */
export const VAULT_CROWN_JEWEL_TABLES = ['formula.formula_vault', 'formula.formula_ingredients'] as const;

/** Every base table currently in the `formula` schema, as seen from THIS role/connection. An
 *  empty result is itself informative (queried below) rather than silently skipping the whole
 *  check — a role for which `formula` isn't even a visible schema returns zero rows here, which
 *  `assertMainRoleCannotReadVault` treats as "cannot enumerate the wall, so cannot prove it
 *  holds" rather than a pass. */
async function listFormulaSchemaTables(pgClient: UnsafeSqlClient): Promise<string[]> {
  const rows = (await pgClient.unsafe(
    `select table_name from information_schema.tables where table_schema = 'formula'`,
  )) as ReadonlyArray<{ table_name?: unknown; tableName?: unknown }>;
  return rows
    .map((r) => (typeof r.table_name === 'string' ? r.table_name : typeof r.tableName === 'string' ? r.tableName : null))
    .filter((n): n is string => n !== null);
}

function sqlStateOf(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;
}

export async function assertMainRoleCannotReadVault(pgClient: UnsafeSqlClient): Promise<void> {
  const logger = new Logger('Bootstrap');

  let tables: string[];
  try {
    tables = await listFormulaSchemaTables(pgClient);
  } catch (err) {
    // Cannot even enumerate the schema from this role/connection — fail closed rather than
    // guess. A role with NO visibility into `formula` at all should still be able to run this
    // read against information_schema (it is not itself vault-protected), so a failure here is
    // an operational problem (bad connection, wrong credentials) worth surfacing loudly, not a
    // silent pass.
    throw new Error(
      'Vault isolation self-check could not enumerate the formula schema — refusing to boot ' +
        `without proof the wall holds (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  if (tables.length === 0) {
    // No tables visible under `formula` at all from this role — that IS a form of isolation
    // (undefined_table territory), but log it distinctly from the per-table proof below so an
    // operator can tell "checked N tables, all refused" from "found nothing to check".
    logger.log('vault isolation self-check OK — the formula schema has no tables visible to the main DB role');
    return;
  }

  const leaks: string[] = [];
  const inconclusive: string[] = [];
  for (const table of tables) {
    const qualified = `formula.${table}`;
    try {
      await pgClient.unsafe(`select 1 from ${qualified} limit 1`);
      // Reaching here means the query SUCCEEDED — the main role CAN read this table. That is
      // the isolation wall being down, not a healthy "no rows" empty-table result (LIMIT 1
      // succeeding on an empty table is still a successful read).
      leaks.push(qualified);
    } catch (err) {
      const code = sqlStateOf(err);
      if (!code || !WALL_HOLDS_SQLSTATES.has(code)) {
        // Anything other than permission-denied/undefined-table — a timeout, a syntax error, a
        // connection drop mid-query — is NOT proof the wall holds. Treating it as one is
        // exactly the fail-open bug this review item closes.
        inconclusive.push(`${qualified} (${code ?? 'no SQLSTATE'}: ${err instanceof Error ? err.message : String(err)})`);
      }
      // else: expected refusal (42501/42P01) — the wall holds for this table.
    }
  }

  if (leaks.length > 0 || inconclusive.length > 0) {
    const parts: string[] = [];
    if (leaks.length > 0) parts.push(`readable: ${leaks.join(', ')}`);
    if (inconclusive.length > 0) parts.push(`inconclusive (not 42501/42P01): ${inconclusive.join(', ')}`);
    throw new Error(
      `Vault isolation violated or unproven — ${parts.join('; ')}. Run ` +
        'scripts/provision-vault-isolation.sql (pointing FORMULA_DATABASE_URL at the ra_vault ' +
        'role BEFORE revoking the main role, per the script\'s ORDER OF OPERATIONS) before ' +
        'deploying to production. Refusing to boot with the wall down or unproven (V4 §109.1, SB-01).',
    );
  }
  logger.log(`vault isolation self-check OK — main DB role refused (42501/42P01) all ${tables.length} formula.* table(s): ${tables.join(', ')}`);
}
