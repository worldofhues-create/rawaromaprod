/**
 * OPS-GREEN (lane ops-factory) — two IDENTICAL internal-bridge requests in the same second are
 * two requests, not a replay. Seen live in the golden journey: the WEIGH step resolved the
 * coded instruction right after the floor's own read, the Vault asked the main box for the same
 * material alias twice within a second, and the L1 replay cache refused the second (401). A
 * signed per-request nonce keeps them distinct; a true replay (same nonce) is still refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../../config/config.service.js';
import { DomainError } from '../domain-error.js';
import { InternalBridgeGuard } from '../internal-bridge.guard.js';
import { computeInternalBridgeSignature } from '../internal-bridge-signing.js';

const KEY = 'a-shared-secret-distributed-via-ssm';
const guard = () => new InternalBridgeGuard(new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vonly_test', JWT_SECRET: 'x'.repeat(32), INTERNAL_BRIDGE_KEY: KEY,
}));

function request(nonce: string | undefined, timestamp: string) {
  const path = '/internal/vault-bridge/material-alias/01a0d6e6-b62e-7ac5-8a15-31c07cbfd15e';
  const signature = computeInternalBridgeSignature(KEY, { method: 'GET', path, body: '', timestamp, ...(nonce ? { nonce } : {}) });
  const headers: Record<string, string> = { 'x-internal-signature': signature, 'x-internal-timestamp': timestamp };
  if (nonce) headers['x-internal-nonce'] = nonce;
  const req = { method: 'GET', url: path, headers, rawBody: '' };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

test('identical GETs in the same second, each with its own nonce, both pass', () => {
  const g = guard();
  const ts = String(Math.floor(Date.now() / 1000));
  assert.equal(g.canActivate(request(randomUUID(), ts)), true);
  assert.equal(g.canActivate(request(randomUUID(), ts)), true);
});

test('a verbatim replay (same nonce) is still refused', () => {
  const g = guard();
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  assert.equal(g.canActivate(request(nonce, ts)), true);
  assert.throws(() => g.canActivate(request(nonce, ts)), (e: unknown) => e instanceof DomainError && /Replayed/.test((e as Error).message));
});

test('a nonce that was not signed (header swapped after signing) fails verification', () => {
  const g = guard();
  const ts = String(Math.floor(Date.now() / 1000));
  const ctx = request(randomUUID(), ts);
  ctx.switchToHttp().getRequest().headers['x-internal-nonce'] = randomUUID();
  assert.throws(() => g.canActivate(ctx), (e: unknown) => e instanceof DomainError && /Invalid or expired/.test((e as Error).message));
});
