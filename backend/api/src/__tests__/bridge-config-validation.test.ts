/**
 * Security review R1 #4/#5 — `PUT /v1/bridge/config` (backend/api/src/bridge/
 * bridge.controller.ts, config-admin.service.ts):
 *
 *   #4: the route had NO zod validation at all, and `webhookUrl` was passed straight through
 *       with no scheme/host checks, so an admin (or anyone reaching this route) could point
 *       RawProd's own outbound webhook at an internal address (SSRF).
 *   #5: `configuredBy` was hardcoded to the literal string 'admin' regardless of who actually
 *       called the route, losing the real actor for the audit trail.
 *
 * Covers the new `configureBridgeRequest` zod schema (@core/contracts, clusters/bridge/config)
 * directly — https required, and each of loopback/RFC1918/link-local/metadata/IPv6-loopback/
 * IPv6-ULA/localhost refused — plus that a well-formed public https URL still validates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridge } from '@core/contracts';

const { configureBridgeRequest } = bridge;

function parse(webhookUrl: string) {
  return configureBridgeRequest.safeParse({ webhookUrl });
}

test('bridge config: a well-formed public https URL is accepted', () => {
  const r = parse('https://alembic.example.com/webhooks/rawprod');
  assert.equal(r.success, true);
});

test('bridge config: http:// (no TLS) is refused — https is required', () => {
  const r = parse('http://alembic.example.com/webhooks/rawprod');
  assert.equal(r.success, false);
});

test('bridge config: IPv4 loopback (127.0.0.1) is refused', () => {
  assert.equal(parse('https://127.0.0.1/hook').success, false);
});

test('bridge config: `localhost` is refused', () => {
  assert.equal(parse('https://localhost/hook').success, false);
});

test('bridge config: RFC1918 private ranges are refused (10.x, 172.16-31.x, 192.168.x)', () => {
  assert.equal(parse('https://10.0.0.5/hook').success, false);
  assert.equal(parse('https://172.16.0.5/hook').success, false);
  assert.equal(parse('https://172.31.255.255/hook').success, false);
  assert.equal(parse('https://192.168.1.1/hook').success, false);
  // A 172.x address OUTSIDE the 16-31 second octet range is a real public address, not private.
  assert.equal(parse('https://172.32.0.1/hook').success, true);
  assert.equal(parse('https://172.15.0.1/hook').success, true);
});

test('bridge config: link-local (169.254.0.0/16) is refused, including the 169.254.169.254 cloud metadata address', () => {
  assert.equal(parse('https://169.254.169.254/latest/meta-data/').success, false);
  assert.equal(parse('https://169.254.1.1/hook').success, false);
});

test('bridge config: IPv6 loopback (::1) is refused', () => {
  assert.equal(parse('https://[::1]/hook').success, false);
});

test('bridge config: IPv6 unique local addresses (fc00::/7) are refused', () => {
  assert.equal(parse('https://[fd00::1]/hook').success, false);
  assert.equal(parse('https://[fc00::1]/hook').success, false);
});

test('bridge config: IPv6 link-local (fe80::/10) is refused', () => {
  assert.equal(parse('https://[fe80::1]/hook').success, false);
});

test('bridge config: an IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) is refused', () => {
  assert.equal(parse('https://[::ffff:127.0.0.1]/hook').success, false);
});

test('bridge config: a malformed URL is refused', () => {
  assert.equal(parse('not-a-url').success, false);
});

test('bridge config: webhookUrl is optional (enabling/disabling without changing the URL is allowed)', () => {
  const r = configureBridgeRequest.safeParse({ enabled: true });
  assert.equal(r.success, true);
});

test('bridge config: hmacSecret must be at least 16 characters', () => {
  assert.equal(configureBridgeRequest.safeParse({ hmacSecret: 'short' }).success, false);
  assert.equal(configureBridgeRequest.safeParse({ hmacSecret: 'a'.repeat(32) }).success, true);
});

test('bridge config: unknown extra fields are stripped, not an error (zod default object behavior)', () => {
  const r = configureBridgeRequest.safeParse({ enabled: true, extra: 'nope' } as never);
  assert.equal(r.success, true);
});
