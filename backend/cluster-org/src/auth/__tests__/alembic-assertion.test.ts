/**
 * PB-04 / SB-02 — `verifyAlembicAssertion`, RawProd's half of the one-login identity bridge.
 *
 * NO NETWORK, NO DATABASE. Every assertion here is signed by a keypair generated in this
 * file, the same discipline ALEMBIC's own `workos-jwks.test.ts` and its
 * `rawprod-assertion.test.ts` use — a real ALEMBIC deployment is not reachable from a unit
 * test and could not be made to produce a tampered or wrongly-audienced token on demand
 * anyway, which is exactly what the cases below need.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { verifyAlembicAssertion } from '../alembic-assertion.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const { privateKey: otherPrivate } = generateKeyPairSync('ed25519');

const VERIFY_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const ISSUER = 'alembic';
const AUDIENCE = 'rawprod';
const NOW = new Date('2026-09-24T10:00:00.000Z');

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(claims: Record<string, unknown>, opts: {
  key?: typeof privateKey; alg?: string; corruptSig?: boolean;
} = {}): string {
  const header = { alg: opts.alg ?? 'EdDSA', typ: 'JWT' };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const key = opts.key ?? privateKey;
  const sig = edSign(null, Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), key);
  const sigB64 = opts.corruptSig
    ? b64url(Buffer.concat([sig.subarray(0, sig.length - 1), Buffer.from([sig[sig.length - 1]! ^ 0xff])]))
    : b64url(sig);
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function baseClaims(overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(NOW.getTime() / 1000);
  return {
    iss: ISSUER, aud: AUDIENCE, sub: 'staff:admin@rawaroma.local',
    tenant_id: 't1', org_id: 't1', email: 'admin@rawaroma.local',
    roles: ['admin'], target: 'factory', iat: nowSec, exp: nowSec + 45, jti: 'jti-1',
    ...overrides,
  };
}

function verify(token: string, now = NOW) {
  return verifyAlembicAssertion({ token, verifyKeyB64: VERIFY_KEY_B64, issuer: ISSUER, audience: AUDIENCE, now });
}

test('a validly signed, in-window assertion verifies', () => {
  const out = verify(sign(baseClaims()));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.claims.email, 'admin@rawaroma.local');
  assert.equal(out.claims.target, 'factory');
});

test('BAD SIGNATURE — signed by a different key is refused', () => {
  const out = verify(sign(baseClaims(), { key: otherPrivate }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'BAD_SIGNATURE');
});

test('BAD SIGNATURE — a tampered signature byte is refused', () => {
  const out = verify(sign(baseClaims(), { corruptSig: true }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'BAD_SIGNATURE');
});

test('BAD SIGNATURE — a payload edited after signing is refused (tamper-evidence)', () => {
  const token = sign(baseClaims());
  const [h, , s] = token.split('.');
  const tampered = { ...baseClaims(), roles: ['admin', 'platform_super_admin'] };
  const badPayload = b64url(Buffer.from(JSON.stringify(tampered), 'utf8'));
  const out = verify(`${h}.${badPayload}.${s}`);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'BAD_SIGNATURE');
});

test('UNSUPPORTED_ALG — alg: none is refused, never accepted as unsigned', () => {
  // Build a header claiming `none` but still present a real signature — the point is that the
  // header's `alg` must never be trusted to pick the verification path.
  const out = verify(sign(baseClaims(), { alg: 'none' }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'UNSUPPORTED_ALG');
});

test('EXPIRED — a token past its exp (beyond clock-skew tolerance) is refused', () => {
  const nowSec = Math.floor(NOW.getTime() / 1000);
  const out = verify(sign(baseClaims({ iat: nowSec - 120, exp: nowSec - 60 })));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'EXPIRED');
});

test('a token within the small clock-skew tolerance past exp still verifies', () => {
  const nowSec = Math.floor(NOW.getTime() / 1000);
  const out = verify(sign(baseClaims({ iat: nowSec - 50, exp: nowSec - 3 })));
  assert.equal(out.ok, true);
});

test('NOT_YET_VALID — a token whose iat is well in the future is refused', () => {
  const nowSec = Math.floor(NOW.getTime() / 1000);
  const out = verify(sign(baseClaims({ iat: nowSec + 120, exp: nowSec + 180 })));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'NOT_YET_VALID');
});

test('WRONG_AUDIENCE — aud !== "rawprod" is refused', () => {
  const out = verify(sign(baseClaims({ aud: 'some-other-service' })));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'WRONG_AUDIENCE');
});

test('WRONG_ISSUER — iss !== "alembic" is refused', () => {
  const out = verify(sign(baseClaims({ iss: 'not-alembic' })));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'WRONG_ISSUER');
});

test('MALFORMED — not three dot-separated segments', () => {
  const out = verify('not-a-jws');
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'MALFORMED');
});

test('MALFORMED — a required claim missing', () => {
  const claims = baseClaims() as Record<string, unknown>;
  delete claims.email;
  const out = verify(sign(claims));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refusal, 'MALFORMED');
});

test('auth_time is carried through when present, absent when not', () => {
  const withAuthTime = verify(sign(baseClaims({ auth_time: Math.floor(NOW.getTime() / 1000) - 30 })));
  assert.equal(withAuthTime.ok, true);
  if (withAuthTime.ok) assert.equal(typeof withAuthTime.claims.auth_time, 'number');

  const without = verify(sign(baseClaims()));
  assert.equal(without.ok, true);
  if (without.ok) assert.equal(without.claims.auth_time, undefined);
});
