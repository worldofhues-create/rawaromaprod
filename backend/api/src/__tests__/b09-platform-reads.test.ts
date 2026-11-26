/**
 * B09 (STUB-075): the five Platform readings RAC OS asked for and this box did not serve, until now
 * answered "The Factory does not send this" by the RAC OS relay:
 *
 *   GET  /v1/platform/vault-health          the main box's link to the Vault, and the Vault's verdict
 *   GET  /v1/platform/health/samples        the tiles' history (in-memory, 30 s, 7 days)
 *   GET  /v1/bridge/outbox                  the RawProd -> RAC OS events, parked or all, paged
 *   GET  /v1/platform/audit-chain           the main box's hash chain by month, each month walked
 *   POST /v1/platform/audit-chain/verify    the whole walk, the first break named, nothing repaired
 *
 * Proves: each is routed where the console asks, behind `platformops:console:read` (owner and
 * platform_super_admin only, as the rest of this controller); the answers carry no secret, no
 * address, no payload and no free text; the chain walk names an edited, a deleted and a re-linked
 * entry; and, against a real Postgres (backend/test-support/schema.sql), the SQL reads what it says
 * and the verify leaves every row exactly as it found it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { chainHash, type StoredChainRow } from '@core/cluster-platform';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { PlatformOpsController, PlatformOutboxController } from '../platform-ops/platform-ops.controller.js';
import { PlatformReadsService, safeDeliveryError, outboxSearch, clampInt } from '../platform-ops/platform-reads.service.js';
import { HealthSamplerService, SAMPLES_KEPT } from '../platform-ops/health-sampler.service.js';
import { walkChain } from '../platform-ops/audit-chain.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { ROLES, PLATFORM_OPS_PERMISSION } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const reflector = new Reflector();
const guard = new PermissionsGuard(reflector);
const grantFor = (code: string) => { const r = ROLES.find((x) => x.code === code)!; return RA_PERMISSIONS.filter((p) => r.select(p)); };

/* ── routing and permission ──────────────────────────────────────────────────────────────── */

const ROUTED: ReadonlyArray<[unknown, string, RequestMethod, string]> = [
  [PlatformOpsController, 'vaultHealth', RequestMethod.GET, 'v1/platform/vault-health'],
  [PlatformOpsController, 'healthSamples', RequestMethod.GET, 'v1/platform/health/samples'],
  [PlatformOpsController, 'auditChain', RequestMethod.GET, 'v1/platform/audit-chain'],
  [PlatformOpsController, 'verifyAuditChain', RequestMethod.POST, 'v1/platform/audit-chain/verify'],
  [PlatformOutboxController, 'list', RequestMethod.GET, 'v1/bridge/outbox'],
];

for (const [ctl, method, verb, path] of ROUTED) {
  const C = ctl as { prototype: Record<string, unknown>; name: string };
  test(`B09 · ${RequestMethod[verb]} /${path} is served, behind platformops:console:read`, () => {
    const fn = C.prototype[method] as object;
    assert.ok(fn, `${C.name}.${method} exists`);
    const base = String(reflector.get(PATH_METADATA, C as never) ?? '');
    const sub = String(reflector.get(PATH_METADATA, fn as never) ?? '');
    assert.equal([base, sub].filter((x) => x && x !== '/').join('/'), path);
    assert.equal(reflector.get(METHOD_METADATA, fn as never), verb);
    const ctx = (user: unknown) => ({ getHandler: () => fn, getClass: () => C, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as never;
    for (const role of ['owner', 'platform_super_admin']) {
      assert.equal(guard.canActivate(ctx(principal({ roles: [role], permissions: grantFor(role) }))), true, role);
    }
    for (const role of ['admin', 'procurement', 'qc', 'warehouse']) {
      assert.throws(() => guard.canActivate(ctx(principal({ roles: [role], permissions: grantFor(role) }))),
        (e: unknown) => e instanceof DomainError && e.status === 403, `${role} is refused`);
    }
    assert.ok(PLATFORM_OPS_PERMISSION === 'platformops:console:read');
  });
}

/* ── the chain walk (pure) ───────────────────────────────────────────────────────────────── */

function chain(n: number, t0 = Date.parse('2026-10-31T18:00:00Z')): StoredChainRow[] {
  const out: StoredChainRow[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const row = { chainSeq: BigInt(i), occurredAt: new Date(t0 + i * 3_600_000), actorId: randomUUID(), action: 'flag.update', entityType: 'flags',
      entityId: randomUUID(), before: { key: 'all.search', env: 'prod', state: 'on' }, after: { key: 'all.search', env: 'prod', state: 'off', reason: 'test' } };
    const rowHash = chainHash(prev, row);
    out.push({ ...row, prevHash: prev, rowHash });
    prev = rowHash;
  }
  return out;
}

test('B09 · an intact chain walks clean and gives its head', () => {
  const rows = chain(6);
  const w = walkChain(rows);
  assert.deepEqual(w, { ok: true, rows: 6, lastSeq: 6, lastHash: rows[5]!.rowHash });
  /* a walk that starts mid-chain carries the row before it */
  assert.equal(walkChain(rows.slice(3), { expectedSeq: 4n, prevHash: rows[2]!.rowHash }).ok, true);
});

test('B09 · an edited entry, a deleted one and a re-linked one are each named as the first break', () => {
  const edited = chain(6); edited[3] = { ...edited[3]!, after: { key: 'all.search', env: 'prod', state: 'on' } };
  assert.deepEqual(walkChain(edited), { ok: false, rows: 6, firstBadSeq: 4, reason: 'Entry 4 was changed after it was written: its hash does not recompute.' });
  const deleted = chain(6).filter((r) => r.chainSeq !== 3n);
  assert.deepEqual(walkChain(deleted), { ok: false, rows: 5, firstBadSeq: 4, reason: 'Entries 3 to 3 are missing: an entry was deleted.' });
  const relinked = chain(6); relinked[2] = { ...relinked[2]!, prevHash: 'f'.repeat(64) };
  const w = walkChain(relinked);
  assert.ok(!w.ok && w.firstBadSeq === 3 && /does not name the entry before it/.test(w.reason));
  /* the reasons carry no row content */
  for (const v of [walkChain(edited), walkChain(deleted), w]) assert.doesNotMatch(JSON.stringify(v), /all\.search|flag\.update|prod/);
});

/* ── the vault link ──────────────────────────────────────────────────────────────────────── */

const VAULT = 'http://10.0.9.4:3101/secret-path';
const reads = (env: Record<string, string | undefined>, fetchImpl?: PlatformReadsService['fetchImpl']) => {
  const s = new PlatformReadsService({} as never, { get: (k: string) => env[k] } as never);
  if (fetchImpl) s.fetchImpl = fetchImpl;
  return s;
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('B09 · vault health: no link configured says so and asks nothing', async () => {
  let asked = 0;
  const v = await reads({}, async () => { asked++; return json(200, {}); }).vaultHealth();
  assert.equal(asked, 0);
  assert.equal(v.configured, false);
  assert.equal(v.reachable, null);
  assert.match(v.note, /no link to the Vault configured/);
});

test("B09 · vault health: the Vault's own /health is asked over the link, its verdict passed on, its address never", async () => {
  const asked: string[] = [];
  const up = await reads({ VAULT_API_INTERNAL_URL: VAULT }, async (url, init) => {
    asked.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    return json(200, { data: { status: 'ok', deps: { formulaDatabase: 'up', 'bad key!': 'up', other: 'sideways' }, at: '2026-11-26T00:00:00.000Z' }, meta: {}, error: null });
  }).vaultHealth();
  assert.deepEqual(asked, [`${VAULT}/health`]);
  assert.equal(up.reachable, true);
  assert.equal(up.status, 'ok');
  assert.deepEqual(up.deps, { formulaDatabase: 'up' }, 'only well-formed up/down entries pass');
  assert.ok(Number.isFinite(up.latencyMs));
  const down = await reads({ VAULT_API_INTERNAL_URL: VAULT }, async () => json(200, { status: 'degraded', deps: { formulaDatabase: 'down' } })).vaultHealth();
  assert.equal(down.status, 'degraded');
  assert.deepEqual(down.deps, { formulaDatabase: 'down' });
  const gone = await reads({ VAULT_API_INTERNAL_URL: VAULT }, async () => { throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.9.4:3101'); }).vaultHealth();
  assert.equal(gone.reachable, false);
  assert.equal(gone.note, 'The Vault could not be reached from this box.');
  const slow = await reads({ VAULT_API_INTERNAL_URL: VAULT }, async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }).vaultHealth();
  assert.match(slow.note, /did not answer within 3 s/);
  for (const v of [up, down, gone, slow]) assert.doesNotMatch(JSON.stringify(v), /10\.0\.9\.4|secret-path|3101/, 'no address leaves');
});

/* ── the outbox list's safety rules ──────────────────────────────────────────────────────── */

test('B09 · outbox: only coded errors pass, the search is never a pattern, paging is clamped', () => {
  assert.equal(safeDeliveryError('http_409: SKU_NOT_MAPPED'), 'http_409: SKU_NOT_MAPPED');
  assert.equal(safeDeliveryError('http_502'), 'http_502');
  assert.equal(safeDeliveryError('network: getaddrinfo ENOTFOUND raw.example.in'), 'network');
  assert.equal(safeDeliveryError('customer priya@example.com refused'), null);
  assert.equal(outboxSearch(' fg.batch '), 'fg.batch');
  assert.equal(outboxSearch('%'), null);
  assert.equal(outboxSearch("x' or 1=1"), null);
  assert.equal(clampInt('500', 12, 1, 100), 100);
  assert.equal(clampInt('-3', 12, 1, 100), 12);
  assert.equal(clampInt('abc', 12, 1, 100), 12);
});

/* ── the sampler ─────────────────────────────────────────────────────────────────────────── */

test('B09 · samples: oldest first, a page of the newest, null where a figure could not be read', async () => {
  let dbDown = false;
  const ops = { deepHealth: async () => { if (dbDown) throw new Error('down'); return { database: 'up', outbox: [{ schema: 'bridge', backlog: 2, oldestUnpublishedSeconds: 41.6 }, { schema: 'production', backlog: 0, oldestUnpublishedSeconds: null }], at: '', note: '' }; } };
  const sql = Object.assign(async () => { if (dbDown) throw new Error('down'); return [{ n: 3 }]; }, {});
  const vault = { vaultHealth: async () => ({ configured: true, reachable: true, status: 'ok' }) };
  const s = new HealthSamplerService(sql as never, ops as never, vault as never);
  const t0 = Date.parse('2026-11-26T00:00:00Z');
  for (let i = 0; i < 9; i++) await s.sampleOnce(new Date(t0 + i * 30_000));
  dbDown = true;
  await s.sampleOnce(new Date(t0 + 9 * 30_000));
  const page = s.samples();
  assert.equal(page.held, 10);
  assert.equal(page.at.length, 7);
  assert.equal(page.at[0], new Date(t0 + 3 * 30_000).toISOString(), 'oldest first');
  assert.deepEqual(page.services, [2, 2, 2, 2, 2, 2, 1]);
  assert.deepEqual(page.servicesTotal, [2, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(page.outboxLagSeconds, [42, 42, 42, 42, 42, 42, null]);
  assert.deepEqual(page.devicesOffline, [3, 3, 3, 3, 3, 3, null]);
  assert.equal(page.nextCursor, '7');
  const older = s.samples({ cursor: '7', limit: '7' });
  assert.equal(older.at.length, 3);
  assert.equal(older.nextCursor, null);
  assert.ok(SAMPLES_KEPT === 20_160);
});

/* ── against a real Postgres ─────────────────────────────────────────────────────────────── */

let svc: PlatformReadsService;
const TYPE = `b09.test.${randomUUID().slice(0, 8)}`;
const ids: string[] = [];

before(async () => {
  await ensureSchema();
  svc = new PlatformReadsService(testClient() as never, { get: () => undefined } as never);
});
after(async () => {
  const sql = testClient();
  if (ids.length) {
    await sql`delete from bridge.outbox_delivery where outbox_id = any(${ids}::uuid[])`;
    await sql`delete from bridge.outbox where id = any(${ids}::uuid[])`;
  }
  await sql`delete from platform.audit_events where chain_seq is not null and action = 'b09.test'`;
  await closeTestClient();
});

test('B09 · outbox (db): parked first, all newest first, counted, coded, never the payload', async () => {
  const sql = testClient();
  const at = (m: number) => new Date(Date.parse('2026-11-20T00:00:00Z') + m * 60_000);
  for (let i = 0; i < 5; i++) {
    const id = randomUUID(); ids.push(id);
    await sql`insert into bridge.outbox (id, type, payload, aggregate_id, occurred_at, published_at, attempts)
              values (${id}::uuid, ${TYPE}, ${sql.json({ customer: 'priya@example.com', grams: 1200 })}, ${randomUUID()}::uuid, ${at(i)}, ${i === 4 ? at(10) : null}, 0)`;
    if (i < 3) {
      await sql`insert into bridge.outbox_delivery (outbox_id, attempts, next_attempt_at, last_error, last_http_status, parked_at, parked_reason, updated_at)
                values (${id}::uuid, 8, ${at(20)}, ${i === 0 ? 'http_409: SKU_NOT_MAPPED' : i === 1 ? 'network: connect ECONNREFUSED 10.1.2.3:443' : 'free text with priya@example.com'},
                        ${i === 0 ? 409 : null}, ${at(30 + i)}, ${i === 0 ? 'permanent' : 'max_attempts'}, ${at(30)})`;
    }
  }
  const parked = await svc.outbox({ state: 'parked', q: TYPE });
  assert.equal(parked.state, 'parked');
  assert.equal(parked.total, 3);
  assert.ok(parked.parkedTotal >= 3);
  assert.deepEqual(parked.events.map((e) => e.state), ['parked', 'parked', 'parked']);
  assert.deepEqual(parked.events.map((e) => e.lastError), ['http_409: SKU_NOT_MAPPED', 'network', null]);
  assert.equal(parked.events[0]!.lastHttpStatus, 409);
  const all = await svc.outbox({ state: 'all', q: TYPE, limit: '2' });
  assert.equal(all.total, 5);
  assert.equal(all.events.length, 2);
  assert.equal(all.events[0]!.state, 'delivered', 'newest first');
  assert.equal(all.nextCursor, '2');
  const rest = await svc.outbox({ state: 'all', q: TYPE, limit: '2', cursor: all.nextCursor });
  assert.deepEqual(rest.events.map((e) => e.state), ['parked', 'parked']);
  const text = JSON.stringify([parked, all, rest]);
  assert.doesNotMatch(text, /priya|grams|10\.1\.2\.3|payload/, 'no payload, no person, no address');
});

test('B09 · audit chain (db): months walked on read, the verify names an edited entry, and repairs nothing', async () => {
  const sql = testClient();
  const [chained] = await sql<Array<{ n: number }>>`select count(*)::int as n from platform.audit_events where chain_seq is not null`;
  const n = chained?.n ?? 0;
  /* the walk starts at entry 1, so this test needs the chain to itself; it never deletes another's rows */
  assert.equal(n, 0, 'run against a database with no chained platform.audit_events rows (TEST_DATABASE_URL, own lane)');
  /* five entries across two India-time months: 31 Oct 23:30 IST is still October, 1 Nov 00:30 IST is November */
  const times = ['2026-10-30T10:00:00Z', '2026-10-31T18:00:00Z', '2026-10-31T19:00:00Z', '2026-11-02T05:00:00Z', '2026-11-03T05:00:00Z'];
  let prev: string | null = null;
  for (let i = 0; i < times.length; i++) {
    const row = { chainSeq: BigInt(i + 1), occurredAt: new Date(times[i]!), actorId: randomUUID(), action: 'b09.test', entityType: 'flags', entityId: randomUUID(),
      before: { state: 'on' }, after: { state: 'off', reason: 'B09 test' } };
    const rowHash = chainHash(prev, row);
    await sql`insert into platform.audit_events (id, actor_id, action, entity_type, entity_id, before, after, occurred_at, chain_seq, prev_hash, row_hash)
              values (${randomUUID()}::uuid, ${row.actorId}::uuid, ${row.action}, ${row.entityType}, ${row.entityId}::uuid, ${sql.json(row.before)}, ${sql.json(row.after)},
                      ${row.occurredAt}, ${String(row.chainSeq)}::bigint, ${prev}, ${rowHash})`;
    prev = rowHash;
  }
  const page = await svc.auditChain({});
  assert.equal(page.rows, 5);
  assert.equal(page.headSeq, 5);
  assert.equal(page.headHash, prev);
  assert.deepEqual(page.segments.map((s) => [s.month, s.entries, s.firstSeq, s.lastSeq, s.verified]), [['2026-11', 3, 3, 5, true], ['2026-10', 2, 1, 2, true]]);
  assert.ok(page.verifiedAt);
  assert.doesNotMatch(JSON.stringify(page), /B09 test|b09\.test/, 'no entry content leaves');
  assert.deepEqual(await svc.verifyChain().then((v) => [v.ok, v.rows]), [true, 5]);

  const before = await sql`select chain_seq::text, after, prev_hash, row_hash from platform.audit_events where action = 'b09.test' order by chain_seq`;
  await sql`update platform.audit_events set after = ${sql.json({ state: 'on', reason: 'B09 test' })} where action = 'b09.test' and chain_seq = 4`;
  try {
    const bad = await svc.verifyChain();
    assert.ok(!bad.ok && bad.firstBadSeq === 4 && bad.month === '2026-11', JSON.stringify(bad));
    const seg = (await svc.auditChain({})).segments;
    assert.deepEqual(seg.map((s) => [s.month, s.verified, s.firstBadSeq]), [['2026-11', false, 4], ['2026-10', true, null]]);
    const after = await sql`select chain_seq::text, after, prev_hash, row_hash from platform.audit_events where action = 'b09.test' order by chain_seq`;
    assert.deepEqual(after.map((r) => [r.chain_seq, r.prev_hash, r.row_hash]), before.map((r) => [r.chain_seq, r.prev_hash, r.row_hash]), 'the verify repaired nothing');
  } finally {
    await sql`delete from platform.audit_events where action = 'b09.test' and chain_seq is not null`;
  }
});
