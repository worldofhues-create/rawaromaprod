/**
 * RC6 — EmailNotifierService drains only the outboxes its connection can see.
 *
 * `formula.outbox` lives in the VAULT database, not the main one the MAIN API's in-process worker is
 * connected to (prod and demo both run the main migrate with SKIP_TARGETS=formula). The drain unioned all
 * seven outboxes regardless, so Postgres refused the whole statement -- `relation "formula.outbox" does not
 * exist`, logged every 5 s -- and no outbox-driven email was sent from ANY schema. The notifier now reads
 * which outboxes exist once, drains those, and says once, at info level, what it skipped.
 *
 * The first three tests use a fake `sql` (no database); the last runs the real catalogue read and the real
 * drain statement against TEST_DATABASE_URL with formula.outbox renamed away inside a rolled-back
 * transaction, which is exactly the main database's shape on a box.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { EmailNotifierService, outboxSchemasPresent } from '../notify/email-notifier.service.js';
import type { EmailTransport } from '../notify/email-transport.service.js';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';

const ALL = ['procurement', 'quality', 'production', 'packaging', 'sales', 'formula', 'inventory'];

type Logs = { log: string[]; warn: string[] };
function capture(svc: EmailNotifierService): Logs {
  const logs: Logs = { log: [], warn: [] };
  (svc as unknown as { logger: unknown }).logger = {
    log: (m: string) => logs.log.push(m),
    warn: (m: string) => logs.warn.push(m),
    error: (m: string) => logs.warn.push(m),
  };
  return logs;
}
const transport = { send: async () => ({ status: 'LOGGED' as const }) } as unknown as EmailTransport;
const drain = (svc: EmailNotifierService) => (svc as unknown as { drain(): Promise<void> }).drain();

/** A fake postgres.js client: the catalogue read answers `present` (or throws), `unsafe` records the drain. */
function fakeSql(present: () => string[]) {
  const calls = { probe: 0, drains: [] as string[] };
  const sql = ((strings: TemplateStringsArray) => {
    if (strings.join('?').includes('pg_catalog.pg_class')) {
      calls.probe++;
      return Promise.resolve(present().map((schema) => ({ schema })));
    }
    return Promise.resolve([]);
  }) as unknown as Sql & { unsafe: (q: string) => Promise<unknown[]> };
  (sql as unknown as { unsafe: (q: string) => Promise<unknown[]> }).unsafe = (q: string) => {
    calls.drains.push(q);
    return Promise.resolve([]);
  };
  return { sql, calls };
}

test('main database (no formula schema): the drain never names formula.outbox, and says so ONCE at info level', async () => {
  const { sql, calls } = fakeSql(() => ALL.filter((s) => s !== 'formula'));
  const svc = new EmailNotifierService(sql, transport);
  const logs = capture(svc);
  await drain(svc);
  await drain(svc);
  await drain(svc);
  assert.equal(calls.probe, 1, 'the catalogue is read once, not on every tick');
  assert.equal(calls.drains.length, 3);
  for (const q of calls.drains) {
    assert.doesNotMatch(q, /formula\.outbox/);
    for (const s of ALL.filter((x) => x !== 'formula')) assert.match(q, new RegExp(`from ${s}\\.outbox`));
  }
  assert.deepEqual(logs.warn, [], 'a missing formula schema is not a warning');
  const said = logs.log.filter((m) => /skipping/.test(m));
  assert.equal(said.length, 1, 'said once, not every 5 s');
  assert.match(said[0] ?? '', /skipping formula -- no formula\.outbox in this database \(formula\.outbox lives in the vault database\)/);
});

test('single-database setup (formula present): formula.outbox IS drained, and nothing is reported skipped', async () => {
  const { sql, calls } = fakeSql(() => ALL);
  const svc = new EmailNotifierService(sql, transport);
  const logs = capture(svc);
  await drain(svc);
  assert.match(calls.drains[0] ?? '', /from formula\.outbox/);
  assert.equal(logs.log.filter((m) => /skipping/.test(m)).length, 0);
  assert.match(logs.log.join('\n'), /draining the outbox of procurement, quality, production, packaging, sales, formula, inventory/);
});

test('a catalogue read that fails is warned about, nothing is drained, and the next tick retries', async () => {
  let fail = true;
  const { sql, calls } = fakeSql(() => {
    if (fail) throw new Error('connection refused');
    return ['procurement'];
  });
  const svc = new EmailNotifierService(sql, transport);
  const logs = capture(svc);
  await drain(svc);
  assert.equal(calls.drains.length, 0, 'no drain on an unknown set of outboxes');
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0] ?? '', /could not read which outboxes exist \(connection refused\); will retry/);
  fail = false;
  await drain(svc);
  assert.equal(calls.drains.length, 1);
  assert.match(calls.drains[0] ?? '', /^select id, type, payload, occurred_at from \(select id, type, payload::text as payload, occurred_at from procurement\.outbox\) e/);
});

test('REAL DATABASE: with formula.outbox absent, the catalogue read omits it and the drain statement runs clean', async () => {
  await ensureSchema();
  const db = testClient();
  const ROLLBACK = new Error('rollback');
  await db.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const before = await outboxSchemasPresent(t);
    assert.ok(before.includes('procurement'), `procurement.outbox should exist in the test database: ${before.join(',')}`);
    if (before.includes('formula')) await t.unsafe('alter table formula.outbox rename to outbox_rc6_hidden');
    const after = await outboxSchemasPresent(t);
    assert.ok(!after.includes('formula'), 'formula must be omitted once formula.outbox is gone');
    assert.deepEqual(after, before.filter((s) => s !== 'formula'));
    const svc = new EmailNotifierService(t, transport);
    const logs = capture(svc);
    await drain(svc);
    assert.deepEqual(logs.warn, [], `the drain failed against a main-shaped database: ${logs.warn.join(' | ')}`);
    assert.match(logs.log.join('\n'), /skipping formula/);
    throw ROLLBACK;
  }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
});

after(async () => { await closeTestClient(); });
