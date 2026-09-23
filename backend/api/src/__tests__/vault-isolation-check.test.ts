/**
 * S3 security review item 8 — `assertMainRoleCannotReadVault` must (a) only accept SQLSTATE
 * `42501`/`42P01` as proof the wall holds (never a bare catch-all), and (b) discover the table
 * list live from `information_schema.tables` rather than a hard-coded two-table constant, so a
 * table added to `formula.*` later is still probed. Fake `UnsafeSqlClient` — no real Postgres
 * needed: every case here turns on which SQLSTATE (or lack of one) a query throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMainRoleCannotReadVault, type UnsafeSqlClient } from '../vault-isolation-check.js';

class PgError extends Error {
  constructor(public readonly code: string, message = 'pg error') {
    super(message);
  }
}

function fakeClient(opts: {
  tables: string[];
  /** table -> error to throw ('OK' = the query succeeds, i.e. a LEAK) */
  outcomes: Record<string, 'OK' | PgError>;
}): UnsafeSqlClient {
  return {
    async unsafe(query: string) {
      if (query.includes('information_schema.tables')) {
        return opts.tables.map((table_name) => ({ table_name }));
      }
      const match = /from formula\.(\w+)/.exec(query);
      const table = match?.[1];
      if (!table) throw new Error(`test double could not parse table from: ${query}`);
      const outcome = opts.outcomes[table];
      if (outcome === 'OK' || outcome === undefined) return [{ '?column?': 1 }];
      throw outcome;
    },
  };
}

test('all tables refused with 42501 — self-check passes', async () => {
  const client = fakeClient({
    tables: ['formula_vault', 'formula_ingredients'],
    outcomes: {
      formula_vault: new PgError('42501'),
      formula_ingredients: new PgError('42501'),
    },
  });
  await assert.doesNotReject(() => assertMainRoleCannotReadVault(client));
});

test('all tables refused with 42P01 (schema not visible at all) — self-check passes', async () => {
  const client = fakeClient({
    tables: ['formula_vault'],
    outcomes: { formula_vault: new PgError('42P01') },
  });
  await assert.doesNotReject(() => assertMainRoleCannotReadVault(client));
});

test('a table the main role CAN actually read is a leak — refuses to boot', async () => {
  const client = fakeClient({
    tables: ['formula_vault', 'formula_ingredients'],
    outcomes: { formula_vault: new PgError('42501'), formula_ingredients: 'OK' },
  });
  await assert.rejects(
    () => assertMainRoleCannotReadVault(client),
    /formula\.formula_ingredients/,
  );
});

test('an error that is NOT 42501/42P01 is inconclusive, not a pass (the fail-open bug this closes)', async () => {
  const client = fakeClient({
    tables: ['formula_vault'],
    // A generic connection/timeout error must never read as "the wall holds".
    outcomes: { formula_vault: new PgError('08006', 'connection reset') },
  });
  await assert.rejects(
    () => assertMainRoleCannotReadVault(client),
    /inconclusive/,
  );
});

test('an error with no SQLSTATE at all is inconclusive, not a pass', async () => {
  const client: UnsafeSqlClient = {
    async unsafe(query: string) {
      if (query.includes('information_schema.tables')) return [{ table_name: 'formula_vault' }];
      throw new Error('some non-pg error with no .code');
    },
  };
  await assert.rejects(() => assertMainRoleCannotReadVault(client), /inconclusive/);
});

test('a NEW table nobody hard-coded is still discovered and probed', async () => {
  const client = fakeClient({
    tables: ['formula_vault', 'formula_ingredients', 'formula_new_secret_table'],
    outcomes: {
      formula_vault: new PgError('42501'),
      formula_ingredients: new PgError('42501'),
      formula_new_secret_table: 'OK', // leak on a table the old hard-coded list never checked
    },
  });
  await assert.rejects(
    () => assertMainRoleCannotReadVault(client),
    /formula\.formula_new_secret_table/,
  );
});

test('the formula schema having zero visible tables is treated as isolation, not skipped', async () => {
  const client = fakeClient({ tables: [], outcomes: {} });
  await assert.doesNotReject(() => assertMainRoleCannotReadVault(client));
});

test('failing to enumerate the schema at all fails closed', async () => {
  const client: UnsafeSqlClient = {
    async unsafe() {
      throw new Error('cannot even query information_schema');
    },
  };
  await assert.rejects(() => assertMainRoleCannotReadVault(client), /could not enumerate/);
});
