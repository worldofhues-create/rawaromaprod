/**
 * Lane platform-roles (2026-09-28) — a signed-in Factory/Platform session survives a reload
 * (backend/api/src/crypto/session-cookie.ts + crypto.controller.ts).
 *
 * Boots a real Nest/Fastify app with the real CryptoModule (handshake + /rpc), the real envelope
 * interceptor and Fastify trustProxy, plus a stub /auth controller that echoes what it was sent. A
 * Node client performs the same ECDH -> HKDF -> AES-GCM handshake the consoles do, so every
 * assertion here is about what a browser actually receives: the outer Set-Cookie and the sealed
 * body. Also proves the tunnel now hands the inner request the caller's real IP and User-Agent.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { Body, Controller, Get, Module, Post, Req, UnauthorizedException } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ResponseEnvelopeInterceptor } from '@core/backend-kernel';
import { CryptoModule } from '../crypto/crypto.module.js';
import {
  SESSION_COOKIE, clearSessionCookie, isSameOriginRequest, readSessionCookie, secondsUntilExpiry, setSessionCookie,
} from '../crypto/session-cookie.js';

/** A refresh-token-shaped JWT (only its `exp` is ever read by the cookie code). */
function fakeJwt(expSecFromNow: number, tag = randomBytes(6).toString('hex')): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ exp: Math.floor(Date.now() / 1000) + expSecFromNow, tag })}.sig`;
}

const seen: Array<{ route: string; body: unknown; ip: string; ua: string | undefined }> = [];

@Controller()
class StubAuthController {
  @Post('auth/alembic-assertion')
  assertion(@Body() body: { assertion?: string }, @Req() req: { ip: string; headers: Record<string, string> }) {
    seen.push({ route: 'assertion', body, ip: req.ip, ua: req.headers['user-agent'] });
    return { user: { email: 'a@x' }, accessToken: 'access-1', refreshToken: fakeJwt(30 * 86400), expiresIn: 900 };
  }

  @Post('auth/refresh')
  refresh(@Body() body: { refreshToken?: string }) {
    seen.push({ route: 'refresh', body, ip: '', ua: undefined });
    if (!body?.refreshToken || body.refreshToken === 'expired-token') throw new UnauthorizedException('Invalid or expired refresh token');
    return { user: { email: 'a@x' }, accessToken: 'access-2', refreshToken: fakeJwt(30 * 86400, 'rotated'), expiresIn: 900 };
  }

  @Get('me')
  me() { return { ok: true }; }
}

@Module({
  imports: [CryptoModule],
  controllers: [StubAuthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor }],
})
class TestModule {}

let app: NestFastifyApplication;
let fastify: { inject: (o: unknown) => Promise<{ statusCode: number; payload: string; headers: Record<string, unknown> }> };

before(async () => {
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter({ trustProxy: true }), { logger: false });
  await app.init();
  fastify = app.getHttpAdapter().getInstance() as never;
});

after(async () => { await app.close(); });

/** The console side of the tunnel, in Node. */
async function channel() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const hs = await fastify.inject({
    method: 'POST', url: '/crypto/handshake', headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ clientPub: ecdh.getPublicKey().toString('base64') }),
  });
  const { keyId, serverPub } = JSON.parse(hs.payload).data as { keyId: string; serverPub: string };
  const key = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(Buffer.from(serverPub, 'base64')), Buffer.alloc(0), Buffer.from('ra-session-v1'), 32));
  return async function call(inner: Record<string, unknown>, headers: Record<string, string> = {}) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(inner))), c.final()]);
    const res = await fastify.inject({
      method: 'POST', url: '/rpc',
      headers: { 'content-type': 'application/json', 'x-ra-key': keyId, ...headers },
      payload: JSON.stringify({ enc: Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64') }),
    });
    const blob = Buffer.from(JSON.parse(res.payload).data.enc, 'base64');
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(blob.length - 16));
    const opened = JSON.parse(Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString('utf8')) as { status: number; body: string };
    const setCookie = res.headers['set-cookie'];
    return { status: opened.status, json: opened.body ? JSON.parse(opened.body) : null, setCookie: Array.isArray(setCookie) ? setCookie[0] : setCookie as string | undefined };
  };
}

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'user-agent': 'Mozilla/5.0 (test browser)', 'x-forwarded-for': '198.51.100.23' };

test('sign-in with persist: the refresh token goes into an HttpOnly Secure SameSite=Strict cookie on /rpc, and out of the body', async () => {
  const call = await channel();
  const r = await call({ method: 'POST', path: '/auth/alembic-assertion', body: { assertion: 'a' }, persist: true }, SAME_ORIGIN);
  assert.equal(r.status, 201);
  assert.equal(r.json.data.accessToken, 'access-1');
  assert.equal('refreshToken' in r.json.data, false, 'page script must never see the refresh token');
  assert.ok(r.setCookie);
  assert.match(r.setCookie!, new RegExp(`^${SESSION_COOKIE}=[^;]+; Max-Age=\\d+; Path=/rpc; HttpOnly; Secure; SameSite=Strict$`));
  const maxAge = Number(/Max-Age=(\d+)/.exec(r.setCookie!)![1]);
  assert.ok(maxAge > 29 * 86400 && maxAge <= 30 * 86400, 'lives as long as the refresh token itself');
});

test('the tunnel hands the inner request the caller\'s real IP (X-Forwarded-For via trustProxy) and User-Agent', async () => {
  const call = await channel();
  seen.length = 0;
  await call({ method: 'POST', path: '/auth/alembic-assertion', body: { assertion: 'a' } }, SAME_ORIGIN);
  assert.equal(seen[0]!.ip, '198.51.100.23');
  assert.equal(seen[0]!.ua, 'Mozilla/5.0 (test browser)');
});

test('a reload restores the session: /auth/refresh with no body is fed the saved cookie, and the cookie is renewed', async () => {
  const call = await channel();
  const signIn = await call({ method: 'POST', path: '/auth/alembic-assertion', body: { assertion: 'a' }, persist: true }, SAME_ORIGIN);
  const cookie = signIn.setCookie!.split(';')[0]!;
  seen.length = 0;
  const reload = await channel(); // a reload is a new page: new channel, only the cookie survives
  const r = await reload({ method: 'POST', path: '/auth/refresh', persist: true }, { ...SAME_ORIGIN, cookie: `other=1; ${cookie}` });
  assert.equal(r.status, 201);
  assert.equal(r.json.data.accessToken, 'access-2');
  assert.equal('refreshToken' in r.json.data, false);
  assert.equal((seen[0]!.body as { refreshToken: string }).refreshToken, cookie.slice(SESSION_COOKIE.length + 1));
  assert.match(r.setCookie!, /rotated|Max-Age=\d+/);
});

test('no saved session: a plain 401 the console turns into the sign-in card — the auth route is never called', async () => {
  const call = await channel();
  seen.length = 0;
  const r = await call({ method: 'POST', path: '/auth/refresh', persist: true }, SAME_ORIGIN);
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'AUTH_TOKEN_INVALID');
  assert.equal(seen.length, 0);
});

test('a refused refresh clears the cookie', async () => {
  const call = await channel();
  const r = await call({ method: 'POST', path: '/auth/refresh', persist: true }, { ...SAME_ORIGIN, cookie: `${SESSION_COOKIE}=expired-token` });
  assert.equal(r.status, 401);
  assert.equal(r.setCookie, clearSessionCookie());
});

test('sign-out clears the cookie', async () => {
  const call = await channel();
  const r = await call({ method: 'POST', path: '/auth/logout', persist: true }, SAME_ORIGIN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data, { signedOut: true });
  assert.equal(r.setCookie, clearSessionCookie());
});

test('a sibling *.huecycle.in page (same-site, not same-origin) can neither use nor receive the cookie', async () => {
  const call = await channel();
  const cross = { 'sec-fetch-site': 'same-site', cookie: `${SESSION_COOKIE}=${fakeJwt(3600)}` };
  seen.length = 0;
  const refresh = await call({ method: 'POST', path: '/auth/refresh', persist: true }, cross);
  assert.equal(seen.some((s) => (s.body as { refreshToken?: string } | undefined)?.refreshToken), false, 'the saved cookie is never read for it');
  assert.ok(refresh.status >= 400, 'no session is restored');
  const signIn = await call({ method: 'POST', path: '/auth/alembic-assertion', body: { assertion: 'a' }, persist: true }, cross);
  assert.equal(signIn.setCookie, undefined);
});

test('without persist (the Vault, and any other tunnel client) nothing changes: no cookie, refresh token in the body', async () => {
  const call = await channel();
  const r = await call({ method: 'POST', path: '/auth/alembic-assertion', body: { assertion: 'a' } }, SAME_ORIGIN);
  assert.equal(r.setCookie, undefined);
  assert.equal(typeof r.json.data.refreshToken, 'string');
  const seenBefore = seen.length;
  const refresh = await call({ method: 'POST', path: '/auth/refresh' }, { ...SAME_ORIGIN, cookie: `${SESSION_COOKIE}=${fakeJwt(3600)}` });
  assert.ok(refresh.status >= 400, 'the cookie is not used unless the console asks');
  assert.equal(seen.slice(seenBefore).some((s) => (s.body as { refreshToken?: string } | undefined)?.refreshToken), false);
});

test('helpers: cookie parsing, expiry, same-origin rules', () => {
  assert.equal(readSessionCookie({ cookie: `a=1; ${SESSION_COOKIE}=tok.en.x; b=2` }), 'tok.en.x');
  assert.equal(readSessionCookie({ cookie: 'a=1' }), null);
  assert.equal(readSessionCookie({}), null);
  assert.equal(secondsUntilExpiry('garbage'), 0);
  assert.ok(secondsUntilExpiry(fakeJwt(100)) <= 100 && secondsUntilExpiry(fakeJwt(100)) >= 98);
  assert.match(setSessionCookie(fakeJwt(-5)), /Max-Age=0;/);
  assert.equal(isSameOriginRequest({ 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(isSameOriginRequest({ 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(isSameOriginRequest({ 'sec-fetch-site': 'same-site' }), false);
  assert.equal(isSameOriginRequest({ origin: 'https://rawfactory.huecycle.in', host: 'rawfactory.huecycle.in' }), true);
  assert.equal(isSameOriginRequest({ origin: 'https://rawadmin.huecycle.in', host: 'rawfactory.huecycle.in' }), false);
  assert.equal(isSameOriginRequest({ origin: 'not a url', host: 'x' }), false);
  assert.equal(isSameOriginRequest({}), true, 'no browser, no ambient cookie');
});
