/**
 * Internal bridge signing — the one signed, service-to-service HTTP channel between the main
 * app box and the standalone Vault EC2 (PB-03 remainder, V4 §109.1's "signed internal channel").
 * Used BOTH directions: `VaultApiClient` (main → vault: a production order's pick list, the coded
 * manufacturing instruction, security-audit writes) and `MaterialFactsClient` (vault → main, the
 * Vault console's material search and alias lookups —
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
  /** A fresh random value per request (`x-internal-nonce`). Without it two IDENTICAL requests
   *  inside the same second (a GET of one material's alias, a coded instruction resolved twice
   *  in a second) carried identical signatures and the L1 replay cache refused the second as a
   *  replay: live, the WEIGH step's instruction lookup straight after the floor's own read failed
   *  with 401 "Replayed internal bridge signature". Signed, so a replay still repeats the nonce
   *  and is still refused. Optional only so a sender predating it still verifies. */
  nonce?: string;
}

/** A real clock difference between two independent boxes must never read as a forged/replayed
 *  request — the same margin this repo's other cross-box verifiers (`alembic-assertion.ts`,
 *  `FreshAuthGuard`) give themselves, scaled up slightly for plain box-to-box clock drift. */
export const INTERNAL_BRIDGE_CLOCK_SKEW_S = 60;

function canonicalMessage(input: InternalBridgeSignInput): string {
  const head = `${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n`;
  return input.nonce ? `${head}${input.nonce}\n${input.body}` : `${head}${input.body}`;
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

/**
 * L1 (security review) — replay cache for the internal channel. The HMAC + timestamp window
 * alone lets a captured request be replayed verbatim for as long as its timestamp is inside
 * the skew window; this closes that by remembering every accepted signature until it could no
 * longer verify anyway, and refusing a second use.
 *
 * A signature can verify while |now - ts| <= INTERNAL_BRIDGE_CLOCK_SKEW_S, i.e. over a span of
 * up to 2x the skew in receiver time, so entries are retained for 2x the skew window.
 *
 * SINGLE-PROCESS ASSUMPTION: the cache is in-memory, per receiving process. That is correct for
 * this channel's deployment — each receiver (the Vault EC2's vault-api, the main app box's api)
 * runs as ONE Node process behind its SG-scoped port — and deliberately avoids a DB dependency
 * (the Vault box has its own isolated DB and no shared store with the app box). If a receiver
 * is ever scaled to >1 process, this must move to a shared store (e.g. a unique-keyed table).
 *
 * BOUNDED: at most `maxEntries` live signatures. When full (after purging expired entries) it
 * fails CLOSED — refuses new requests rather than evicting a live entry (evicting would reopen
 * the replay window). Only a holder of INTERNAL_BRIDGE_KEY can fill it.
 */
export class InternalBridgeReplayCache {
  private readonly seen = new Map<string, number>(); // signature -> expiry (ms epoch)
  constructor(
    private readonly maxEntries = 10_000,
    private readonly retentionMs = 2 * INTERNAL_BRIDGE_CLOCK_SKEW_S * 1000,
  ) {}

  get size(): number { return this.seen.size; }

  private purge(now: number): void {
    // Map preserves insertion order and expiries are monotonic in insertion time, so stop at
    // the first live entry.
    for (const [sig, exp] of this.seen) {
      if (exp > now) break;
      this.seen.delete(sig);
    }
  }

  /** Returns true (and records it) if `signature` has not been seen within the window;
   *  false if it is a replay, or if the cache is full (fail closed). */
  checkAndRecord(signature: string, now: number = Date.now()): boolean {
    this.purge(now);
    const exp = this.seen.get(signature);
    if (exp !== undefined && exp > now) return false;
    if (this.seen.size >= this.maxEntries) return false;
    this.seen.set(signature, now + this.retentionMs);
    return true;
  }
}
