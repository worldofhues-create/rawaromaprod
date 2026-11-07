// HOST-LOCK-2: a rollback file that leaves its ledger row behind. db-migrate.ts skips any block whose
// id is in public.schema_migrations, so after 2026-11-07-stock3.down.sql dropped issued_amount the
// next deploy of the same code skipped the migration and ran against a column that was gone, with the
// migrate unit reporting success.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchema, testClient } from '../../../test-support/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROLLBACK = join(ROOT, 'scripts/migrations/rollback');
const read = (file: string) => readFileSync(join(ROLLBACK, file), 'utf8');

test('every rollback file deletes its own ledger rows and nobody else\'s', () => {
  const files = readdirSync(ROLLBACK).filter((f) => f.endsWith('.down.sql'));
  assert.ok(files.length >= 10, `only ${files.length} rollback files found`);
  for (const file of files) {
    const name = file.replace(/\.down\.sql$/, '');
    const deletes = [...read(file).matchAll(/delete from public\.schema_migrations where id like '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(deletes, [`${name}%`], `${file} must clear exactly its own ledger rows`);
  }
});

before(ensureSchema);
after(() => testClient().end());

// Inside a transaction that is always undone: other test files need issued_amount.
test('stock3 down clears its row, leaves stock2\'s, and the migration can then run again', async () => {
  const undone = new Error('undo');
  await assert.rejects(
    testClient().begin(async (tx) => {
      const hasColumn = async () => (await tx`
        select 1 from information_schema.columns
        where table_schema = 'production' and table_name = 'production_order_ingredients' and column_name = 'issued_amount'
      `).length === 1;
      const ledger = async () => (await tx<{ id: string }[]>`
        select id from public.schema_migrations where id like '2026-11-07-stock%' order by id
      `).map((r) => r.id);

      await tx.unsafe('create table if not exists public.schema_migrations (id text primary key, applied_at timestamptz not null default now())');
      await tx`delete from public.schema_migrations where id like '2026-11-07-stock%'`;
      await tx`insert into public.schema_migrations (id) values ('2026-11-07-stock2.sql#0#main'), ('2026-11-07-stock3.sql#0#main')`;
      assert.equal(await hasColumn(), true, 'the test schema should carry the column before the rollback');

      await tx.unsafe(read('2026-11-07-stock3.down.sql'));

      assert.equal(await hasColumn(), false);
      assert.deepEqual(await ledger(), ['2026-11-07-stock2.sql#0#main']);

      await tx.unsafe(readFileSync(join(ROOT, 'scripts/migrations/2026-11-07-stock3.sql'), 'utf8'));
      assert.equal(await hasColumn(), true);
      throw undone;
    }),
    (err) => err === undone,
  );
});
