/**
 * FEATURE-SWITCHES: the kill-switch control plane end to end against a real Postgres
 * (backend/test-support/schema.sql), the way the RAC OS Platform console reaches it through the relay:
 *
 *   - the registry is registered (2026-11-29-flags-register.sql, applied here as the deploy applies
 *     it) with every key in packages/contracts FLAGS, each 'on', so registering changes nothing at
 *     the edge (an unregistered key already read as on);
 *   - GET /v1/admin/flags answers every switch per environment, with who changed it, when and why;
 *   - PUT /v1/admin/flags/:key refuses an unknown key with a 404 in words (it was a bare 500),
 *     writes nothing for a change that changes nothing, and otherwise writes the state, its
 *     flag_audit row, a hash-chained platform.audit_events row and its outbox event together;
 *   - the hash chain verifies, and an edited row is named as the first break;
 *   - a critical key needs a sign-in from the last five minutes.
 * Own iam.user_master row per run (randomUUID), as tutorial.test.ts does.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as platformSchema from '@core/data-platform';
import { FLAGS } from '@core/contracts';
import { PlatformFlagsService } from '../../../cluster-platform/src/flags/flags.service.js';
import { FlagsController } from '../../../cluster-platform/src/flags/flags.controller.js';
import { verifyFlagChain, type StoredChainRow } from '../../../cluster-platform/src/flags/flag-chain.js';
import { FlagsService } from '../../../backend-kernel/src/flags/flags.service.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';

const MIGRATION = fileURLToPath(new URL('../../../../scripts/migrations/2026-11-29-flags-register.sql', import.meta.url));
const ROLLBACK = fileURLToPath(new URL('../../../../scripts/migrations/rollback/2026-11-29-flags-register.down.sql', import.meta.url));

let svc: PlatformFlagsService;
let snapshot: FlagsService;
let ctl: FlagsController;
let userId: string;
const email = `flags-${randomUUID()}@rawaroma.local`;
const bus = { subscribe: () => () => {}, publish: async () => {} };

async function chained(): Promise<StoredChainRow[]> {
  const rows = await testClient()<{ chain_seq: string; occurred_at: Date; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; before: unknown; after: unknown; prev_hash: string | null; row_hash: string | null }[]>`
    select chain_seq::text, occurred_at, actor_id::text, action, entity_type, entity_id::text, before, after, prev_hash, row_hash
      from platform.audit_events where chain_seq is not null order by chain_seq`;
  return rows.map((r) => ({ chainSeq: BigInt(r.chain_seq), occurredAt: r.occurred_at, actorId: r.actor_id, action: r.action, entityType: r.entity_type,
    entityId: r.entity_id, before: r.before, after: r.after, prevHash: r.prev_hash, rowHash: r.row_hash }));
}

const counts = async () => (await testClient()<{ a: number; c: number; o: number }[]>`
  select (select count(*)::int from platform.flag_audit) as a,
         (select count(*)::int from platform.audit_events where chain_seq is not null) as c,
         (select count(*)::int from platform.outbox where type = 'platform.flag.changed') as o`)[0]!;

before(async () => {
  await ensureSchema();
  const sql = testClient();
  // A clean control plane: this file owns these tables in its database.
  await sql`delete from platform.flag_audit`;
  await sql`delete from platform.flag_states`;
  await sql`delete from platform.audit_events where chain_seq is not null`;
  await sql.unsafe(readFileSync(MIGRATION, 'utf8'));
  userId = randomUUID();
  await sql`insert into iam.user_master (user_id, email, user_name, is_active, status)
            values (${userId}, ${email}, 'Flags Test User', true, 'ACTIVE')`;
  snapshot = new FlagsService();
  svc = new PlatformFlagsService(drizzle(sql, { schema: platformSchema }) as never, snapshot, bus as never);
  await svc.reload();
  ctl = new FlagsController(svc);
});

after(async () => {
  const sql = testClient();
  await sql`delete from platform.flag_audit`;
  await sql`delete from platform.flag_states`;
  await sql`delete from platform.audit_events where chain_seq is not null`;
  await closeTestClient();
});

test('the migration registers exactly the contracts registry, every key on, criticals marked', async () => {
  const rows = await testClient()<{ key: string; is_critical: boolean; default_state: string; description: string | null }[]>`
    select key, is_critical, default_state, description from platform.flags order by key`;
  const want = [...FLAGS].map((f) => ({ key: f.key, is_critical: f.critical, default_state: 'on', description: f.description })).sort((a, b) => a.key.localeCompare(b.key));
  assert.deepEqual(rows.map((r) => ({ ...r })), want);
  // Applying it twice registers nothing twice (the deploy runs every migration file on every ship).
  await testClient().unsafe(readFileSync(MIGRATION, 'utf8'));
  assert.equal((await testClient()`select count(*)::int as n from platform.flags`)[0]!.n, FLAGS.length);
});

test('registering changes nothing at the edge: every key reads on, all.auth stays enabled', () => {
  assert.equal(snapshot.all().length, FLAGS.length);
  for (const f of snapshot.all()) assert.equal(f.state, 'on', f.key);
  assert.equal(snapshot.isEnabled('all.auth'), true);
});

test('the admin list: every switch, per environment, with no history it does not hold', async () => {
  const list = await ctl.adminList();
  assert.equal(list.env, 'staging');
  assert.equal(list.flags.length, FLAGS.length);
  const auth = list.flags.find((f) => f.key === 'all.auth')!;
  assert.equal(auth.critical, true);
  assert.equal(auth.description, 'Master auth kill-switch');
  assert.deepEqual(auth.envs.map((e) => [e.env, e.state, e.set, e.changedAt, e.changedBy]), [['staging', 'on', false, null, null], ['prod', 'on', false, null, null]]);
});

test('an unknown key is a 404 in words, not a 500, and nothing is written', async () => {
  const before = await counts();
  await assert.rejects(
    ctl.setFlag('no.such.switch', { env: 'staging', state: 'off', reason: 'Testing' } as never, principal({ userId })),
    (e: unknown) => e instanceof DomainError && e.status === 404 && /no switch called "no\.such\.switch"/.test(e.message),
  );
  assert.deepEqual(await counts(), before);
});

test('a change writes the state, flag_audit, one chained audit row and one outbox event, and the edge sees it', async () => {
  const before = await counts();
  const out = await ctl.setFlag('all.search', { env: 'staging', state: 'off', reason: 'Search index rebuild' } as never, principal({ userId }));
  assert.deepEqual({ key: out.key, state: out.state, env: out.env, unchanged: out.unchanged }, { key: 'all.search', state: 'off', env: 'staging', unchanged: false });
  assert.deepEqual(await counts(), { a: before.a + 1, c: before.c + 1, o: before.o + 1 });
  assert.equal(snapshot.isEnabled('all.search'), false, 'this process enforces staging, so the edge must refuse the route now');

  const row = (await chained()).at(-1)!;
  assert.equal(row.action, 'flag.update');
  assert.equal(row.actorId, userId);
  assert.deepEqual(row.before, { key: 'all.search', env: 'staging', state: null });
  assert.deepEqual(row.after, { key: 'all.search', env: 'staging', state: 'off', reason: 'Search index rebuild' });

  const e = (await ctl.adminList()).flags.find((f) => f.key === 'all.search')!.envs.find((x) => x.env === 'staging')!;
  assert.equal(e.state, 'off');
  assert.equal(e.set, true);
  assert.equal(e.changedBy, email);
  assert.equal(e.reason, 'Search index rebuild');
  assert.ok(e.changedAt && Date.now() - Date.parse(e.changedAt) < 60_000);
});

test('setting the state a switch already holds is unchanged and writes nothing', async () => {
  const before = await counts();
  const out = await ctl.setFlag('all.search', { env: 'staging', state: 'off', reason: 'Pressed twice' } as never, principal({ userId }));
  assert.equal(out.unchanged, true);
  assert.deepEqual(await counts(), before);
});

test('another environment is recorded but does not move this process\'s edge; degraded is a state', async () => {
  await ctl.setFlag('all.uploads', { env: 'prod', state: 'degraded', reason: 'Disk nearly full' } as never, principal({ userId }));
  assert.equal(snapshot.get('all.uploads')?.state, 'on', 'a prod change must not reach a staging process');
  const f = (await ctl.adminList()).flags.find((x) => x.key === 'all.uploads')!;
  assert.deepEqual(f.envs.map((e) => [e.env, e.state]), [['staging', 'on'], ['prod', 'degraded']]);
  await ctl.setFlag('all.search', { env: 'staging', state: 'on', reason: 'Rebuild done' } as never, principal({ userId }));
  assert.equal(snapshot.isEnabled('all.search'), true);
  const last = (await ctl.adminList()).flags.find((x) => x.key === 'all.search')!.envs[0]!;
  assert.equal(last.from, 'off');
  assert.equal(last.reason, 'Rebuild done');
});

test('a critical switch needs a sign-in from the last five minutes', async () => {
  const stale = principal({ userId, authTime: Math.floor(Date.now() / 1000) - 3600 });
  const before = await counts();
  await assert.rejects(
    ctl.setFlag('all.auth', { env: 'prod', state: 'off', reason: 'Incident' } as never, stale),
    (e: unknown) => e instanceof DomainError && e.status === 403 && e.code === 'AUTH_STEP_UP_REQUIRED' && /critical switch/.test(e.message),
  );
  assert.deepEqual(await counts(), before);
  // An ordinary switch asks no fresh sign-in.
  await ctl.setFlag('ops.assignment.auto', { env: 'prod', state: 'off', reason: 'Not a RAC feature' } as never, stale);
  const fresh = await ctl.setFlag('all.auth', { env: 'prod', state: 'degraded', reason: 'Incident' } as never, principal({ userId }));
  assert.equal(fresh.unchanged, false);
});

test('the hash chain verifies, and an edited row is named as the first break', async () => {
  const rows = await chained();
  assert.ok(rows.length >= 5, `expected the changes above in the chain, found ${rows.length}`);
  assert.deepEqual(verifyFlagChain(rows), { ok: true, rows: rows.length });
  const sql = testClient();
  const victim = rows[1]!;
  await sql`update platform.audit_events set after = jsonb_set(after, '{state}', '"on"') where chain_seq = ${victim.chainSeq.toString()}::bigint`;
  try {
    const v = verifyFlagChain(await chained());
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.firstBadSeq, Number(victim.chainSeq));
  } finally {
    await sql`update platform.audit_events set after = ${JSON.stringify(victim.after)}::jsonb where chain_seq = ${victim.chainSeq.toString()}::bigint`;
  }
  assert.equal(verifyFlagChain(await chained()).ok, true);
  // A deleted tail is a gap the next row cannot hide.
  assert.equal(verifyFlagChain([...rows.slice(0, 1), ...rows.slice(2)]).ok, false);
});

test('the rollback removes only keys nobody has set', async () => {
  const sql = testClient();
  await sql.begin(async (tx) => {
    // The migrator's ledger (scripts/db-migrate.ts); this harness never ran the migrator.
    await tx`create table if not exists public.schema_migrations (id text primary key)`;
    await tx.unsafe(readFileSync(ROLLBACK, 'utf8'));
    const left = (await tx<{ key: string }[]>`select key from platform.flags order by key`).map((r) => r.key);
    assert.deepEqual(left, ['all.auth', 'all.search', 'all.uploads', 'ops.assignment.auto']);
    throw new Error('rollback-the-rollback');
  }).catch((e: Error) => { if (e.message !== 'rollback-the-rollback') throw e; });
  assert.equal((await sql`select count(*)::int as n from platform.flags`)[0]!.n, FLAGS.length);
});
