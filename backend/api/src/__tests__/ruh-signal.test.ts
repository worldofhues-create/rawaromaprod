/**
 * Always-on Ruh — C3, the durable signal queue toward ALEMBIC (ruh/ruh-signal.service.ts). Real
 * Postgres on a Drizzle-wrapped pool (the shape the running API's PG_CLIENT has); ALEMBIC is a fake
 * fetch that checks the signature exactly as ALEMBIC does.
 *
 *   signed:  the same signature as the Aria forward (HMAC over `${ts}.${nonce}.${body}`, the same
 *            four x-bridge-* headers), the tenant in the body, a fresh nonce per request;
 *   durable: a down / refusing / not-yet-upgraded ALEMBIC (network error, 500, 401, 404) only moves
 *            the retry out — exponential, capped at 30 min — FOR EVER; nothing is dropped. Only a
 *            body ALEMBIC calls malformed (422 / permanent: true) is parked, and still kept;
 *   ordered: signals and resolves go oldest first; a failure stops the pass so order holds;
 *   dedupe:  one pending row per (op, key): enqueueing again refreshes it; a resolve cancels a pending
 *            signal and a signal cancels a pending resolve;
 *   honest:  an unconfigured connector sends nothing and keeps everything queued.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as bridgeSchema from '@ra/data-bridge';
import { ensureSchema, testClient, closeTestClient, TEST_DATABASE_URL, principal } from '../../../test-support/db.js';
import { sealSecret } from '../bridge/secret-box.js';
import { verifyBody } from '../bridge/signing.js';
import { AriaBridgeService } from '../aria/aria-bridge.service.js';
import { ALEMBIC_RUH_SIGNAL_PATH, BACKOFF_CAP_SECONDS, RuhSignalService, backoffSeconds, isPermanentRefusal } from '../ruh/ruh-signal.service.js';
import type { C3Signal } from '../ruh/ruh.contract.js';

const SECRET = 'ruh-signal-test-secret';
const TENANT = '0190f0a1-0000-7000-8000-00000000a0b1';
const kekPrior = process.env.BRIDGE_HMAC_KEK;
const wrapped = postgres(TEST_DATABASE_URL, { max: 3, prepare: false, types: {}, onnotice: () => {} });
drizzle(wrapped); // exactly what DrizzleModule does to the shared PG_CLIENT
const bdb = drizzle(wrapped, { schema: bridgeSchema });
const config = { get: (k: string) => (k === 'ALEMBIC_ASSERTION_TENANT_ID' ? TENANT : undefined) } as never;

interface Call { url: string; headers: Record<string, string>; body: string }
let calls: Call[] = [];
let reply: (call: Call) => Response | Promise<Response> = () => new Response('{"ok":true}', { status: 200 });
const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
  const call = { url, headers: init.headers, body: init.body };
  calls.push(call);
  return reply(call);
}) as unknown as typeof fetch;
let svc: RuhSignalService;

async function connector(enabled = true) {
  await testClient()`
    insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed, configured_by)
    values ('default', ${enabled}, 'https://alembic.example.test/api/v1/bridge/rawprod/events', ${sealSecret(SECRET)}, 'test')
    on conflict (id) do update set enabled = excluded.enabled, webhook_url = excluded.webhook_url, hmac_secret_sealed = excluded.hmac_secret_sealed`;
}
const sig = (key: string, over: Partial<C3Signal> = {}): C3Signal => ({
  kind: 'production.late', severity: 'warn', title: `T ${key}`, body: 'B', dedupeKey: key, audienceRoles: ['ops'], ...over,
});
const rows = async (key?: string) => (await testClient()`
  select op, dedupe_key, attempts, delivered_at, parked_at, last_error, last_http_status, payload,
         extract(epoch from (next_attempt_at - now()))::float as wait
    from bridge.ruh_signal ${key ? testClient()`where dedupe_key = ${key}` : testClient()``} order by seq`) as Array<Record<string, unknown>>;
const enqueue = (s: C3Signal) => wrapped.begin((tx) => svc.enqueueSignal(tx, s));
const resolve = (k: string) => wrapped.begin((tx) => svc.enqueueResolve(tx, k));

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = Buffer.alloc(32, 7).toString('base64');
  svc = new RuhSignalService(wrapped, bdb, config, fakeFetch);
});
beforeEach(async () => {
  await connector(true);
  await testClient()`delete from bridge.ruh_signal`;
  calls = [];
  reply = () => new Response('{"ok":true}', { status: 200 });
});
after(async () => {
  if (kekPrior === undefined) delete process.env.BRIDGE_HMAC_KEK; else process.env.BRIDGE_HMAC_KEK = kekPrior;
  await wrapped.end();
  await closeTestClient();
});

test('dedupe: one pending row per key; a resolve cancels a pending signal, a new signal cancels a pending resolve', async () => {
  await enqueue(sig('k1', { title: 'first' }));
  await enqueue(sig('k1', { title: 'second' }));
  let r = await rows('k1');
  assert.equal(r.length, 1);
  assert.equal((r[0]!.payload as C3Signal).title, 'second', 'the pending payload is refreshed, not duplicated');
  await resolve('k1');
  await resolve('k1');
  r = await rows('k1');
  assert.deepEqual(r.map((x) => x.op), ['resolve'], 'never sent, so the signal is dropped and one resolve stays');
  await enqueue(sig('k1'));
  assert.deepEqual((await rows('k1')).map((x) => x.op), ['signal']);
});

test('signed exactly like the Aria forward: same headers, HMAC over ts.nonce.body with the bridge secret; tenant in the body', async () => {
  await enqueue(sig('s1'));
  await enqueue(sig('s2'));
  const res = await svc.drain();
  assert.deepEqual(res, { sent: 2, failed: 0, parked: 0, state: 'ok' });
  assert.equal(calls.length, 1, 'consecutive signals travel together');
  const c = calls[0]!;
  assert.equal(c.url, `https://alembic.example.test${ALEMBIC_RUH_SIGNAL_PATH}`);
  const body = JSON.parse(c.body) as { tenantId: string; signals: C3Signal[] };
  assert.equal(body.tenantId, TENANT);
  assert.deepEqual(body.signals.map((s) => s.dedupeKey), ['s1', 's2']);
  assert.ok(verifyBody(`${c.headers['x-bridge-timestamp']}.${c.headers['x-bridge-nonce']}.${c.body}`, SECRET, c.headers['x-bridge-signature']));
  assert.ok(Math.abs(Number(c.headers['x-bridge-timestamp']) - Date.now() / 1000) < 5);

  // The Aria forward, through the same fake: the very same header set.
  const ariaUser = randomUUID();
  await testClient()`insert into iam.user_master (user_id, user_name, email, alembic_subject, is_active, status)
                     values (${ariaUser}, 'aria', ${`aria-${ariaUser.slice(0, 6)}@x.test`}, ${randomUUID()}, true, 'ACTIVE')`;
  const aria = new AriaBridgeService(wrapped, bdb, config, (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ text: 'ok', via: 'resolver', cited: [] }), { status: 200 });
  }) as unknown as typeof fetch);
  await aria.ask(principal({ userId: ariaUser }), { question: 'hi', console: 'factory' });
  const ariaCall = calls[calls.length - 1]!;
  assert.deepEqual(Object.keys(ariaCall.headers).sort(), Object.keys(c.headers).sort());
  assert.ok(verifyBody(`${ariaCall.headers['x-bridge-timestamp']}.${ariaCall.headers['x-bridge-nonce']}.${ariaCall.body}`, SECRET, ariaCall.headers['x-bridge-signature']));
  assert.notEqual(ariaCall.headers['x-bridge-nonce'], c.headers['x-bridge-nonce']);
  assert.ok((await rows()).every((r) => r.delivered_at !== null));
});

test('order: a signal and its later resolve go oldest first, as two requests', async () => {
  await enqueue(sig('o1'));
  await svc.drain();
  await resolve('o1');
  await enqueue(sig('o2'));
  calls = [];
  await svc.drain();
  assert.deepEqual(calls.map((c) => Object.keys(JSON.parse(c.body)).sort().join()), ['resolved,tenantId', 'signals,tenantId']);
  assert.deepEqual(JSON.parse(calls[0]!.body).resolved, ['o1']);
});

test('durable: network error, 500, 401 and 404 are retried with backoff for ever — never parked, never dropped', async () => {
  await enqueue(sig('d1'));
  await enqueue(sig('d2'));
  await resolve('d3');
  reply = () => { throw new Error('ECONNREFUSED'); };
  let res = await svc.drain();
  assert.equal(res.failed, 2);
  assert.equal(calls.length, 1, 'the pass stops at the first failure so order holds');
  let r = await rows('d1');
  assert.equal(r[0]!.attempts, 1);
  assert.match(String(r[0]!.last_error), /^network: ECONNREFUSED/);
  assert.ok(Number(r[0]!.wait) > 0 && Number(r[0]!.wait) <= 2.5, 'first retry after ~2 s');
  assert.equal(r[0]!.parked_at, null);

  for (const status of [500, 401, 404]) {
    await testClient()`update bridge.ruh_signal set next_attempt_at = now() where delivered_at is null`;
    reply = () => new Response('{}', { status });
    res = await svc.drain();
    assert.equal(res.parked, 0, `${status} is transient`);
  }
  r = await rows('d1');
  assert.equal(r[0]!.attempts, 4);
  assert.equal(r[0]!.last_http_status, 404);
  // Far past the bridge relay's 12-attempt park: still queued, backoff capped at 30 minutes.
  await testClient()`update bridge.ruh_signal set attempts = 40, next_attempt_at = now() where dedupe_key = 'd1'`;
  await svc.drain();
  r = await rows('d1');
  assert.equal(r[0]!.parked_at, null);
  assert.ok(Number(r[0]!.wait) > BACKOFF_CAP_SECONDS - 5 && Number(r[0]!.wait) <= BACKOFF_CAP_SECONDS + 1);
  assert.equal(backoffSeconds(1), 2);
  assert.equal(backoffSeconds(5), 32);
  assert.equal(backoffSeconds(99), BACKOFF_CAP_SECONDS);

  // ALEMBIC comes back: everything is delivered, in order.
  await testClient()`update bridge.ruh_signal set next_attempt_at = now() where delivered_at is null`;
  reply = () => new Response('{"ok":true}', { status: 200 });
  calls = [];
  res = await svc.drain();
  assert.equal(res.sent, 3);
  assert.deepEqual(calls.map((c) => JSON.parse(c.body).signals?.map((s: C3Signal) => s.dedupeKey) ?? JSON.parse(c.body).resolved), [['d1', 'd2'], ['d3']]);
});

test('a body ALEMBIC calls malformed is parked — kept, counted, never retried blindly', async () => {
  await enqueue(sig('p1'));
  reply = () => new Response(JSON.stringify({ error: 'bad signal', permanent: true }), { status: 400 });
  const res = await svc.drain();
  assert.equal(res.parked, 1);
  const r = await rows('p1');
  assert.ok(r[0]!.parked_at !== null);
  assert.equal(r[0]!.delivered_at, null);
  assert.equal((await svc.counts()).parked, 1);
  assert.ok(isPermanentRefusal(422, {}));
  assert.ok(!isPermanentRefusal(404, {}));
  assert.ok(!isPermanentRefusal(400, { permanent: false }));
});

test('an unconfigured or disabled connector sends nothing and keeps everything queued', async () => {
  await enqueue(sig('u1'));
  await connector(false);
  assert.equal((await svc.drain()).state, 'not_configured');
  assert.equal(calls.length, 0);
  assert.equal((await rows('u1'))[0]!.delivered_at, null);
  const off = new RuhSignalService(wrapped, bdb, { get: () => undefined } as never, fakeFetch);
  await connector(true);
  assert.equal((await off.drain()).state, 'not_configured', 'no tenant id: not configured');
  assert.equal((await svc.counts()).waiting, 1);
});
