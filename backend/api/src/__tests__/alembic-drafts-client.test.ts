/**
 * FLOOR-FIX-11 (Alembic doc 17 §5.3) — the QC-drafts client (factory-setup/alembic-drafts.client.ts),
 * on its own: the signed request it sends ALEMBIC, and what it makes of a refusal, a malformed reply,
 * an unreachable host and a missing connection. (factory-setup.test.ts covers only the happy path.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, bridgeDb, testClient, closeTestClient } from '../../../test-support/db.js';
import { AlembicDraftsClient, ALEMBIC_QC_DRAFTS_PATH } from '../factory-setup/alembic-drafts.client.js';
import { verifyBody } from '../bridge/signing.js';
import { sealSecret } from '../bridge/secret-box.js';

const SECRET = 'drafts-client-test-secret';
const TENANT = '0190f0a1-0000-7000-8000-00000000d4af';
const kekPrior = process.env.BRIDGE_HMAC_KEK;
const config = { get: (k: string) => (k === 'ALEMBIC_ASSERTION_TENANT_ID' ? TENANT : undefined) } as never;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? Buffer.alloc(32, 5).toString('base64');
  await testClient()`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
    values ('default', true, 'https://alembic.example.test/api/v1/bridge/rawprod/events', ${sealSecret(SECRET)})
    on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url, hmac_secret_sealed = excluded.hmac_secret_sealed`;
});
after(async () => {
  if (kekPrior === undefined) delete process.env.BRIDGE_HMAC_KEK; else process.env.BRIDGE_HMAC_KEK = kekPrior;
  await closeTestClient();
});

const reply = (status: number, body: string) => (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('the request: POST to the ALEMBIC origin + qc-drafts path, body {tenantId, subject, skuCodes}, HMAC over timestamp.nonce.body', async () => {
  let seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | null = null;
  const f = (async (url: string, init: never) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, ai: 'used', items: [] }), { status: 200 }); }) as unknown as typeof fetch;
  const r = await new AlembicDraftsClient(bridgeDb(), config, f).qcDrafts(['SKU-A', 'SKU-B'], 'sub-1');
  assert.deepEqual(r, { ok: true, ai: 'used', items: [] });
  const s = seen!;
  assert.equal(s.url, `https://alembic.example.test${ALEMBIC_QC_DRAFTS_PATH}`);
  assert.equal(s.init.method, 'POST');
  assert.deepEqual(JSON.parse(s.init.body), { tenantId: TENANT, subject: 'sub-1', skuCodes: ['SKU-A', 'SKU-B'] });
  const h = s.init.headers;
  assert.equal(h['content-type'], 'application/json');
  assert.match(h['x-bridge-timestamp']!, /^\d{10}$/);
  assert.match(h['x-bridge-nonce']!, /^[0-9a-f-]{36}$/);
  assert.ok(verifyBody(`${h['x-bridge-timestamp']}.${h['x-bridge-nonce']}.${s.init.body}`, SECRET, h['x-bridge-signature']), 'signed with the bridge secret');
  assert.ok(!verifyBody(s.init.body, SECRET, h['x-bridge-signature']), 'not over the bare body');
});

test('a refusal, a malformed reply and an unreachable host each come back as a reason, never a throw', async () => {
  const client = (f: typeof fetch) => new AlembicDraftsClient(bridgeDb(), config, f);
  const subj = await client(reply(403, JSON.stringify({ ok: false, outcome: 'unknown_subject' }))).qcDrafts(['S'], 'x');
  assert.deepEqual([subj.ok, !subj.ok && subj.reason], [false, 'refused']);
  assert.match(!subj.ok ? subj.message : '', /does not recognise your linked account/);
  const other = await client(reply(500, JSON.stringify({ ok: false, outcome: 'boom' }))).qcDrafts(['S'], 'x');
  assert.match(!other.ok ? other.message : '', /refused the request/);
  for (const [status, body] of [[200, 'not json'], [200, '{"ok":true}'], [200, '{"ok":true,"items":"x"}'], [200, '{"ok":false,"items":[]}'], [200, '']] as const) {
    const r = await client(reply(status, body)).qcDrafts(['S'], 'x');
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, 'refused'], body);
  }
  const down = await client((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch).qcDrafts(['S'], 'x');
  assert.deepEqual([down.ok, !down.ok && down.reason], [false, 'unreachable']);
  const noTenant = await new AlembicDraftsClient(bridgeDb(), { get: () => undefined } as never, reply(200, '{}')).qcDrafts(['S'], 'x');
  assert.deepEqual([noTenant.ok, !noTenant.ok && noTenant.reason], [false, 'not_configured']);
});
