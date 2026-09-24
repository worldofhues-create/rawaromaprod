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

/* BRIDGE_WEBHOOK_ALLOWED_HOSTS — the golden-journey gap #3 fix. A single-VPC/local pairing
 * (factory ALEMBIC as a private host) is exactly what this allow-list exists to unblock; an
 * unlisted private host, and the link-local/metadata range regardless of listing, must stay
 * refused. Each test restores the env var afterward so this file's ordering never leaks state
 * into the plain-refusal tests above. */
test('bridge config: BRIDGE_WEBHOOK_ALLOWED_HOSTS admits an exact-listed private host', () => {
  const prev = process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
  process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = '10.0.0.5:8443, 192.168.1.1';
  try {
    assert.equal(parse('https://10.0.0.5:8443/webhooks/rawprod').success, true);
    assert.equal(parse('https://192.168.1.1/webhooks/rawprod').success, true);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
    else process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = prev;
  }
});

test('bridge config: BRIDGE_WEBHOOK_ALLOWED_HOSTS does not widen to an unlisted private host', () => {
  const prev = process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
  process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = '10.0.0.5:8443';
  try {
    assert.equal(parse('https://10.0.0.6:8443/webhooks/rawprod').success, false);
    assert.equal(parse('https://192.168.1.1/hook').success, false);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
    else process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = prev;
  }
});

test('bridge config: an allow-listed host on the WRONG port still refuses (exact host[:port] match)', () => {
  // A bare hostname (not an IP literal, not `localhost`) is not syntactically identifiable as
  // private at all — `isUnsafeWebhookHost` never flags it, allow-list or not (DNS resolution is
  // explicitly out of scope for this boundary; see this file's header) — so this exercises the
  // exactness rule with an IP literal, the one shape the guard actually restricts.
  const prev = process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
  process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = '10.0.0.5:8443';
  try {
    assert.equal(parse('https://10.0.0.5:9999/webhooks/rawprod').success, false);
    assert.equal(parse('https://10.0.0.5/webhooks/rawprod').success, false);
    assert.equal(parse('https://10.0.0.5:8443/webhooks/rawprod').success, true);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
    else process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = prev;
  }
});

test('bridge config: the link-local/metadata range can NEVER be allow-listed, even if named exactly', () => {
  const prev = process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
  process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = '169.254.169.254, 169.254.1.1';
  try {
    assert.equal(parse('https://169.254.169.254/latest/meta-data/').success, false);
    assert.equal(parse('https://169.254.1.1/hook').success, false);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
    else process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = prev;
  }
});

test('bridge config: BRIDGE_WEBHOOK_ALLOWED_HOSTS unset or empty refuses every private host (safe default)', () => {
  const prev = process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
  delete process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
  try {
    assert.equal(parse('https://10.0.0.5/hook').success, false);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
    else process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = prev;
  }
});

/* lane/j2 — plain http:// is admitted ONLY for an allow-listed LOOPBACK host (a same-host
 * pairing: traffic never leaves the machine). Every other http:// URL is still refused,
 * allow-listed or not. */
function withAllowed(value: string, fn: () => void) {
  const prev = process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
  process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS;
    else process.env.BRIDGE_WEBHOOK_ALLOWED_HOSTS = prev;
  }
}

test('bridge config: http:// on an allow-listed loopback host:port is admitted', () => {
  withAllowed('127.0.0.1:4461', () => {
    assert.equal(parse('http://127.0.0.1:4461/api/v1/bridge/rawprod/webhooks/x').success, true);
  });
  withAllowed('localhost:4461', () => {
    assert.equal(parse('http://localhost:4461/hook').success, true);
  });
});

test('bridge config: http:// on an UNLISTED loopback port is still refused', () => {
  withAllowed('127.0.0.1:4461', () => {
    assert.equal(parse('http://127.0.0.1:9999/hook').success, false);
  });
});

test('bridge config: http:// on an allow-listed RFC1918 host is still refused — https required off-box', () => {
  withAllowed('10.0.0.5:8443', () => {
    assert.equal(parse('http://10.0.0.5:8443/hook').success, false);
    assert.equal(parse('https://10.0.0.5:8443/hook').success, true);
  });
});

test('bridge config: http:// on a public host is refused even if (pointlessly) allow-listed', () => {
  withAllowed('alembic.example.com', () => {
    assert.equal(parse('http://alembic.example.com/hook').success, false);
  });
});

test('bridge config: http:// with no allow-list at all is refused (unchanged default)', () => {
  withAllowed('', () => {
    assert.equal(parse('http://127.0.0.1:4461/hook').success, false);
  });
});
