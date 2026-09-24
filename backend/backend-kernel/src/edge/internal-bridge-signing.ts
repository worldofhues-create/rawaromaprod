/**
 * Internal bridge signing — the one signed, service-to-service HTTP channel between the main
 * app box and the standalone Vault EC2 (PB-03 remainder, V4 §109.1's "signed internal channel").
 * Used BOTH directions: `VaultPortHttpClient` (main → vault, resolve a coded manufacturing
 * instruction) and `MaterialFactsClient` (vault → main, resolve a material's RM_ALIAS / search —
 * the only main-DB-shaped read the Vault box ever makes, read-only, alias/code/name only).
 *
 * Deliberately NOT a JWT / bearer-token scheme — there is no user principal on either side of
 * this call, only two trusted processes. An HMAC-SHA256 over method+path+timestamp+body, keyed
 * by a secret shared via SSM (never committed, never baked into an image), is the same shape
 * this repo's `relay` module and `BridgeModule`'s HMAC connector secret already use for
 * cross-boundary signed envelopes — kept here (backend-kernel, domain-free) rather than in
 * either cluster because BOTH directions need the identical primitive and backend-kernel is the
 * one package every deployable already depends on.
 *
 * Domain-free by design (no formula/vault-specific types here) — see `internal-bridge.guard.ts`
 * for the receiving-side NestJS guard built on top of this.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InternalBridgeSignInput {
  /** HTTP method, any case — normalized to uppercase before signing. */
  method: string;
  /** The request path (no scheme/host), exactly as sent — e.g. `/internal/vault/resolve-manufacturing-instruction`. */
  path: string;
  /** The raw request body bytes, as a string — `''` for a body-less request (e.g. GET). Must be
   *  the EXACT bytes sent, never a re-serialization (the same "raw bytes, not a re-parse" rule
   *  `main.ts`'s own content-type parser follows for `BridgeModule`'s HMAC). */
  body: string;
  /** Unix seconds, as a string, stamped by the SENDER — the receiver treats this as the replay
   *  window anchor (`verifyInternalBridgeSignature` below), never trusts a body-carried timestamp. */
  timestamp: string;
}

/** A real clock difference between two independent boxes must never read as a forged/replayed
 *  request — the same margin this repo's other cross-box verifiers (`alembic-assertion.ts`,
 *  `FreshAuthGuard`) give themselves, scaled up slightly for plain box-to-box clock drift. */
export const INTERNAL_BRIDGE_CLOCK_SKEW_S = 60;

function canonicalMessage(input: InternalBridgeSignInput): string {
  return `${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n${input.body}`;
}

/** Compute the signature a sender attaches as `x-internal-signature` (with `x-internal-timestamp`
 *  carrying `input.timestamp`). Base64url so it's header-safe with no further encoding. */
export function computeInternalBridgeSignature(key: string, input: InternalBridgeSignInput): string {
  return createHmac('sha256', key).update(canonicalMessage(input)).digest('base64url');
}

/**
 * Verify a signature the receiver read off `x-internal-signature`. Constant-time compare (never
 * a `===` on secret-derived bytes) + an independent timestamp-window check — a valid signature
 * for a REAL request from long ago must not still verify today; that is what makes this a
 * signed-and-timestamped scheme rather than a bare shared-secret comparison.
 */
export function verifyInternalBridgeSignature(
  key: string,
  input: InternalBridgeSignInput,
  signature: string,
  now: number = Date.now(),
): boolean {
  const expected = computeInternalBridgeSignature(key, input);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const skewSeconds = Math.abs(now / 1000 - ts);
  return skewSeconds <= INTERNAL_BRIDGE_CLOCK_SKEW_S;
}
