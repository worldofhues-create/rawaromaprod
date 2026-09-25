/**
 * UX-H — RawProd's half of the Aria bridge, against real Postgres and a MOCKED ALEMBIC.
 *
 *   - the route needs a RawProd session (the real JwtAuthGuard refuses it without one) and is
 *     self-service (no RawProd permission required — ALEMBIC decides what may be answered);
 *   - a linked, signed-in user's question is forwarded to the origin of the configured bridge
 *     webhook, signed over `${timestamp}.${nonce}.${body}` with the connector's own secret, and
 *     names the ALEMBIC subject read from `user_master` — never anything from the request;
 *   - the Vault console's view never leaves; no page data is ever in the body;
 *   - unconfigured / unlinked / unreachable / refused all come back as honest states, and the
 *     unconfigured and unlinked ones never reach the network at all.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../../backend-kernel/src/edge/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { META_PUBLIC, META_SELF_SERVICE } from '../../../backend-kernel/src/decorators/metadata.keys.js';
import { ensureSchema, testClient, bridgeDb, closeTestClient, principal } from '../../../test-support/db.js';
import { sealSecret } from '../bridge/secret-box.js';
import { verifyBody } from '../bridge/signing.js';
import { AriaBridgeController, ariaAskBody } from './aria-bridge.controller.js';
import { AriaBridgeService, alembicAriaUrl, ALEMBIC_ARIA_PATH } from './aria-bridge.service.js';

const SECRET = 'uxh-rp-aria-bridge-secret';
const TENANT = '0190aaaa-0000-7000-8000-00000000abcd';
const WEBHOOK = 'https://alembic.example.test/api/v1/bridge/rawprod/webhooks/0123456789abcdef';
const kekPrior = process.env.BRIDGE_HMAC_KEK;

/** `null` = ALEMBIC_ASSERTION_TENANT_ID unset. */
const config = (tenant: string | null = TENANT) =>
  ({ get: (k: string) => (k === 'ALEMBIC_ASSERTION_TENANT_ID' ? (tenant ?? undefined) : undefined) }) as never;

interface Captured { url: string; headers: Record<string, string>; body: string }
function fakeAlembic(respond: (c: Captured) => { status: number; body: unknown } | Error) {
  const calls: Captured[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const c: Captured = {
      url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? ''),
    };
    calls.push(c);
    const r = respond(c);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

const linkedUser = randomUUID();
const unlinkedUser = randomUUID();
const inactiveUser = randomUUID();
const subject = randomUUID();
const inactiveSubject = randomUUID();

async function setConnector(enabled: boolean, webhookUrl: string | null = WEBHOOK) {
  const sql = testClient();
  await sql`
    insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed, configured_by)
    values ('default', ${enabled}, ${webhookUrl}, ${sealSecret(SECRET)}, 'uxh-test')
    on conflict (id) do update set enabled = ${enabled}, webhook_url = ${webhookUrl},
      hmac_secret_sealed = ${sealSecret(SECRET)}`;
}

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = Buffer.alloc(32, 21).toString('base64');
  const sql = testClient();
  await sql`insert into iam.user_master (user_id, user_name, email, is_active, status, alembic_subject)
            values (${linkedUser}, 'Linked', ${`uxh-l-${linkedUser}@rp.test`}, true, 'ACTIVE', ${subject}),
                   (${unlinkedUser}, 'Unlinked', ${`uxh-u-${unlinkedUser}@rp.test`}, true, 'ACTIVE', null),
                   (${inactiveUser}, 'Inactive', ${`uxh-i-${inactiveUser}@rp.test`}, false, 'INACTIVE', ${inactiveSubject})`;
  await setConnector(true);
});

after(async () => {
  const sql = testClient();
  await sql`delete from iam.user_master where user_id in (${linkedUser}, ${unlinkedUser}, ${inactiveUser})`;
  await sql`update bridge.connector_config set enabled = false where id = 'default'`;
  if (kekPrior === undefined) delete process.env.BRIDGE_HMAC_KEK;
  else process.env.BRIDGE_HMAC_KEK = kekPrior;
  await closeTestClient();
});

const service = (impl: typeof fetch, tenant?: string) =>
  new AriaBridgeService(testClient(), bridgeDb(), config(tenant ?? TENANT), impl);

const answered = () => ({ status: 200, body: {
  text: 'RAC-1 is ACCEPTED.', via: 'resolver', conversationId: randomUUID(),
  cited: [{ id: 'rawprod:production_requirement_status', label: 'Production requirement', value: 'ACCEPTED', source: 'rawprod', extra: '<b>x</b>' }],
} });

/* ── the session ─────────────────────────────────────────────────────────── */

test('POST /v1/aria/ask needs a RawProd session: the real JwtAuthGuard refuses a request without one', async () => {
  const reflector = new Reflector();
  const jwt = { verifyAccess: async () => { throw new Error('must not be reached without a token'); } };
  const permissions = { resolve: async () => { throw new Error('must not be reached without a token'); } };
  const guard = new JwtAuthGuard(reflector, jwt as never, permissions);
  for (const method of ['ask', 'status'] as const) {
    const handler = (AriaBridgeController.prototype as unknown as Record<string, unknown>)[method];
    assert.notEqual(reflector.get(META_PUBLIC, handler as never), true, `${method} must not be @Public`);
    assert.equal(reflector.get(META_SELF_SERVICE, handler as never), true, `${method} is @SelfService`);
    const ctx = {
      getHandler: () => handler, getClass: () => AriaBridgeController,
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    } as never;
    await assert.rejects(() => guard.canActivate(ctx),
      (err: unknown) => err instanceof DomainError && (err as DomainError).status === 401);
  }
});

test('POST /v1/aria/ask needs no RawProd permission once signed in (ALEMBIC decides the answer)', () => {
  const guard = new PermissionsGuard(new Reflector());
  const handler = (AriaBridgeController.prototype as unknown as Record<string, unknown>).ask;
  const ctx = {
    getHandler: () => handler, getClass: () => AriaBridgeController,
    switchToHttp: () => ({ getRequest: () => ({ user: principal({ userId: linkedUser, permissions: [] }) }) }),
  } as never;
  assert.equal(guard.canActivate(ctx), true);
});

test('the body is validated: a question and a known console are required', () => {
  assert.equal(ariaAskBody.safeParse({ question: 'hi', console: 'factory' }).success, true);
  assert.equal(ariaAskBody.safeParse({ question: '', console: 'factory' }).success, false);
  assert.equal(ariaAskBody.safeParse({ question: 'hi', console: 'storefront' }).success, false);
  assert.equal(ariaAskBody.safeParse({ question: 'x'.repeat(2001), console: 'vault' }).success, false);
});

/* ── forwarding ──────────────────────────────────────────────────────────── */

test('a linked user\'s question is forwarded, signed, to ALEMBIC as their bound subject', async () => {
  const alembic = fakeAlembic(answered);
  const convo = randomUUID();
  const res = await service(alembic.impl).ask(principal({ userId: linkedUser }), {
    question: 'why isn\'t production moving on RAC-1?', console: 'factory', view: 'Batches',
    conversationId: convo, persist: true,
  });

  assert.equal(alembic.calls.length, 1);
  const call = alembic.calls[0]!;
  assert.equal(call.url, `https://alembic.example.test${ALEMBIC_ARIA_PATH}`);
  const { 'x-bridge-timestamp': ts, 'x-bridge-nonce': nonce, 'x-bridge-signature': sig } = call.headers;
  assert.ok(ts && nonce && sig);
  assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 5);
  assert.equal(verifyBody(`${ts}.${nonce}.${call.body}`, SECRET, sig), true,
    'signed with the connector secret over timestamp.nonce.body, the Facts API shape');
  assert.equal(verifyBody(call.body, SECRET, sig), false, 'the bare body alone must not verify');

  const sent = JSON.parse(call.body) as Record<string, unknown>;
  assert.deepEqual(sent, {
    tenantId: TENANT, subject, question: 'why isn\'t production moving on RAC-1?',
    console: 'factory', view: 'Batches', conversationId: convo, persist: true, rawprodUserId: linkedUser,
  });

  assert.equal(res.status, 'answered');
  if (res.status !== 'answered') return;
  assert.equal(res.text, 'RAC-1 is ACCEPTED.');
  assert.equal(res.via, 'resolver');
  assert.deepEqual(res.cited, [{ id: 'rawprod:production_requirement_status', label: 'Production requirement', value: 'ACCEPTED', source: 'rawprod' }],
    'cited facts are narrowed to known string fields');
  assert.match(res.conversationId ?? '', /^[0-9a-f-]{36}$/);
});

test('every request carries a fresh nonce', async () => {
  const alembic = fakeAlembic(answered);
  const svc = service(alembic.impl);
  await svc.ask(principal({ userId: linkedUser }), { question: 'a', console: 'factory' });
  await svc.ask(principal({ userId: linkedUser }), { question: 'a', console: 'factory' });
  assert.notEqual(alembic.calls[0]!.headers['x-bridge-nonce'], alembic.calls[1]!.headers['x-bridge-nonce']);
});

test('the Vault console never sends its view', async () => {
  const alembic = fakeAlembic(answered);
  await service(alembic.impl).ask(principal({ userId: linkedUser }), {
    question: 'what can you tell me?', console: 'vault', view: 'Formula FOUGERE-01' });
  const sent = JSON.parse(alembic.calls[0]!.body) as Record<string, unknown>;
  assert.equal(sent.console, 'vault');
  assert.equal('view' in sent, false);
  assert.equal(alembic.calls[0]!.body.includes('FOUGERE'), false);
});

test('a view that is not a plain name is dropped rather than forwarded', async () => {
  const alembic = fakeAlembic(answered);
  await service(alembic.impl).ask(principal({ userId: linkedUser }), {
    question: 'hi', console: 'platform', view: '<script>alert(1)</script>' });
  assert.equal('view' in (JSON.parse(alembic.calls[0]!.body) as object), false);
});

/* ── the honest states ───────────────────────────────────────────────────── */

test('an unlinked user is told so, and ALEMBIC is never called', async () => {
  const alembic = fakeAlembic(answered);
  const svc = service(alembic.impl);
  for (const userId of [unlinkedUser, inactiveUser, randomUUID()]) {
    const res = await svc.ask(principal({ userId }), { question: 'hi', console: 'factory' });
    assert.equal(res.status, 'unavailable');
    if (res.status === 'unavailable') assert.equal(res.reason, 'not_linked');
  }
  assert.equal(alembic.calls.length, 0);
  assert.deepEqual(await svc.status(principal({ userId: unlinkedUser })),
    { available: false, reason: 'not_linked', message: (await svc.ask(principal({ userId: unlinkedUser }), { question: 'x', console: 'factory' }) as { message: string }).message });
});

test('an unconfigured bridge is not_configured, and ALEMBIC is never called', async () => {
  const alembic = fakeAlembic(answered);
  try {
    await setConnector(false);
    const off = await service(alembic.impl).ask(principal({ userId: linkedUser }), { question: 'hi', console: 'factory' });
    assert.equal(off.status === 'unavailable' && off.reason, 'not_configured', `off: ${JSON.stringify(off)}`);
    await setConnector(true, null);
    const noUrl = await service(alembic.impl).ask(principal({ userId: linkedUser }), { question: 'hi', console: 'factory' });
    assert.equal(noUrl.status === 'unavailable' && noUrl.reason, 'not_configured', `noUrl: ${JSON.stringify(noUrl)}`);
    await setConnector(true);
    const noTenant = await new AriaBridgeService(testClient(), bridgeDb(), config(null), alembic.impl)
      .ask(principal({ userId: linkedUser }), { question: 'hi', console: 'factory' });
    assert.equal(noTenant.status === 'unavailable' && noTenant.reason, 'not_configured', `noTenant: ${JSON.stringify(noTenant)}`);
    assert.equal((await new AriaBridgeService(testClient(), bridgeDb(), config(null), alembic.impl)
      .status(principal({ userId: linkedUser }))).available, false);
    assert.equal(alembic.calls.length, 0);
  } finally {
    await setConnector(true);
  }
  assert.deepEqual(await service(alembic.impl).status(principal({ userId: linkedUser })), { available: true });
});

test('ALEMBIC\'s refusals map to honest states', async () => {
  const cases: Array<[{ status: number; body: unknown } | Error, string]> = [
    [{ status: 401, body: { outcome: 'signature_invalid' } }, 'not_configured'],
    [{ status: 401, body: { outcome: 'replayed' } }, 'not_configured'],
    [{ status: 503, body: { outcome: 'bridge_not_configured' } }, 'not_configured'],
    [{ status: 403, body: { outcome: 'wrong_tenant' } }, 'not_configured'],
    [{ status: 403, body: { outcome: 'unknown_subject' } }, 'not_linked'],
    [{ status: 403, body: { outcome: 'inactive' } }, 'not_linked'],
    [{ status: 429, body: { error: 'slow down' } }, 'rate_limited'],
    [{ status: 404, body: { error: 'no such conversation' } }, 'refused'],
    [new Error('ECONNREFUSED'), 'unreachable'],
  ];
  for (const [reply, reason] of cases) {
    const alembic = fakeAlembic(() => reply);
    const res = await service(alembic.impl).ask(principal({ userId: linkedUser }), { question: 'hi', console: 'factory' });
    assert.equal(res.status, 'unavailable', JSON.stringify(reply));
    if (res.status === 'unavailable') assert.equal(res.reason, reason, JSON.stringify(reply instanceof Error ? reply.message : reply));
  }
});

test('the controller forwards through the service as the signed-in principal', async () => {
  const alembic = fakeAlembic(answered);
  const controller = new AriaBridgeController(service(alembic.impl));
  const res = await controller.ask({ question: 'hi', console: 'factory' }, principal({ userId: linkedUser }));
  assert.equal(res.status, 'answered');
  assert.equal((JSON.parse(alembic.calls[0]!.body) as { subject: string }).subject, subject);
});

test('alembicAriaUrl takes only the origin of the configured webhook', () => {
  assert.equal(alembicAriaUrl('https://raw.example.in/api/v1/bridge/rawprod/webhooks/abc?x=1'),
    `https://raw.example.in${ALEMBIC_ARIA_PATH}`);
  assert.equal(alembicAriaUrl('not a url'), null);
  assert.equal(alembicAriaUrl(null), null);
  assert.equal(alembicAriaUrl('ftp://x.example/'), null);
});
