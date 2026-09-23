/**
 * PB-04 / SB-02 — RawProd's half of the one-login identity bridge. Verifies the
 * short-lived signed assertion ALEMBIC's `apps/api/src/auth/rawprod-assertion.ts`
 * issues, so `AuthService.loginWithAssertion` never has to parse a token itself.
 *
 * HAND-WRITTEN, THE SAME WAY ALEMBIC SIGNS IT. `jwtVerify` (jose, already a
 * dependency of this cluster via JwtService) would work here, but the two
 * things a JWS verifier must never do are (1) let the token's own `alg`
 * header choose HOW it is checked, and (2) accept anything but the one
 * algorithm this bridge was designed for. Reading the header, comparing it
 * to a constant, and calling `crypto.verify(null, ...)` unconditionally makes
 * that a fact about the code rather than a configuration a caller could ever
 * bend — the identical reasoning ALEMBIC's own `workos-jwks.ts` gives for
 * hand-writing its RS256 verifier instead of trusting a library's default.
 *
 * KEY SHAPE: base64 DER, spki, Ed25519 — the same convention this
 * repository's OWN relay signing already uses (`relay-crypto.ts`,
 * `RELAY_VERIFY_KEY`). `ALEMBIC_ASSERTION_VERIFY_KEY` holds only the PUBLIC
 * half; this file can verify and can never sign.
 *
 * REPLAY IS NOT THIS FILE'S JOB. A single verification here says nothing
 * about whether this exact token was already spent — that is `AuthService`'s
 * `jti` store, checked right after a `verify()` that returns `ok: true`. This
 * file answers exactly one question: was this signed, by the key we trust,
 * for us, and is it still within its window.
 */
import { createPublicKey, verify as edVerify } from 'node:crypto';

/** The one algorithm this file will ever accept. Never read from the token's
 *  own header and used to pick a code path — compared against it. */
const ALLOWED_ALG = 'EdDSA';

/** A few seconds of tolerance for clock skew between two independent boxes —
 *  the same margin `FreshAuthGuard` gives itself, and for the identical
 *  reason: a real clock difference must not read as a forged claim. */
const CLOCK_SKEW_TOLERANCE_S = 5;

/** FINAL_OS's own ceiling for a bridge-style assertion (S3 security review item 3): the
 *  window between when ALEMBIC minted the token (`iat`) and when it stops being valid
 *  (`exp`) must never exceed 60s, however the token's OWN `exp`/`iat` claims read.
 *  `rawprod-assertion.ts` signs a 45s TTL today, but this file must not simply trust that —
 *  a compromised or misconfigured issuer minting a longer-lived token is exactly what an
 *  independent ceiling on the RECEIVING side is for. */
const MAX_ASSERTION_WINDOW_S = 60;

export interface AlembicAssertionClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly tenant_id: string;
  readonly org_id: string;
  readonly email: string;
  readonly roles: readonly string[];
  readonly target: string;
  /** REQUIRED (S3 security review item 2) — when the credential behind this assertion was
   *  actually PROVED (OIDC `auth_time` semantics), never when the assertion was minted. See
   *  `rawprod-assertion.ts`'s own claim doc for how ALEMBIC computes it. */
  readonly auth_time: number;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type AlembicAssertionRefusal =
  | 'MALFORMED'
  | 'UNSUPPORTED_ALG'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'WRONG_ISSUER'
  | 'WRONG_AUDIENCE'
  | 'WINDOW_TOO_LONG'
  | 'WRONG_TARGET'
  | 'WRONG_TENANT';

export type AlembicAssertionResult =
  | { readonly ok: true; readonly claims: AlembicAssertionClaims }
  | { readonly ok: false; readonly refusal: AlembicAssertionRefusal; readonly detail: string };

function b64urlDecode(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Verify an ALEMBIC RawProd-identity assertion. Never throws — every
 *  failure is a typed refusal, exactly as `staff-session.ts`'s verifier on
 *  the ALEMBIC side treats "no valid credential" as an ordinary outcome. */
export function verifyAlembicAssertion(opts: {
  readonly token: string;
  readonly verifyKeyB64: string;
  readonly issuer: string;
  readonly audience: string;
  readonly now: Date;
  /** S3 security review item 3 — when set, `target` must equal exactly one of these (the
   *  console/audience this deployment IS). Omitted entirely (undefined/empty) skips the
   *  check — the shared factory+platform deployment has no single fixed target, so callers
   *  there configure both; the standalone Vault box configures only `['vault']`. */
  readonly expectedTargets?: readonly string[];
  /** S3 security review item 3 — when set, both `tenant_id` and `org_id` must equal this
   *  RawProd deployment's own configured tenant/org id. Omitted skips the check (dev/test
   *  default, same "boots without it" posture every other optional security config here
   *  takes). */
  readonly expectedTenantId?: string;
}): AlembicAssertionResult {
  const { token, verifyKeyB64, issuer, audience, now, expectedTargets, expectedTenantId } = opts;
  const nowSec = Math.floor(now.getTime() / 1000);

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, refusal: 'MALFORMED', detail: 'The assertion is not a three-part token.' };
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, refusal: 'MALFORMED', detail: 'The assertion header or payload is not valid JSON.' };
  }

  const alg = header && typeof header === 'object' ? (header as Record<string, unknown>).alg : undefined;
  if (alg !== ALLOWED_ALG) {
    return { ok: false, refusal: 'UNSUPPORTED_ALG', detail: `Only ${ALLOWED_ALG} is accepted.` };
  }

  let key;
  try {
    key = createPublicKey({ key: Buffer.from(verifyKeyB64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return { ok: false, refusal: 'BAD_SIGNATURE', detail: 'ALEMBIC_ASSERTION_VERIFY_KEY is not a valid Ed25519 public key.' };
  }

  let sig: Buffer;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return { ok: false, refusal: 'MALFORMED', detail: 'The assertion signature is not valid base64url.' };
  }

  const signedOk = edVerify(null, Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), key, sig);
  if (!signedOk) {
    return { ok: false, refusal: 'BAD_SIGNATURE', detail: 'The assertion signature does not match.' };
  }

  const p = payload as Record<string, unknown>;
  if (
    !isNonEmptyString(p.sub) || !isNonEmptyString(p.tenant_id) || !isNonEmptyString(p.org_id)
    || !isNonEmptyString(p.email) || !isStringArray(p.roles) || !isNonEmptyString(p.target)
    || !isNonEmptyString(p.jti) || typeof p.iat !== 'number' || typeof p.exp !== 'number'
    || typeof p.iss !== 'string' || typeof p.aud !== 'string'
    // S3 security review item 2: auth_time is now a REQUIRED claim, not an optional one — a
    // token minted without it (an older/misconfigured issuer) is malformed, the same as a
    // missing sub/email, rather than silently treated as "no fresh-auth information".
    || typeof p.auth_time !== 'number'
  ) {
    return { ok: false, refusal: 'MALFORMED', detail: 'The assertion is missing a required claim.' };
  }
  if (p.iss !== issuer) {
    return { ok: false, refusal: 'WRONG_ISSUER', detail: `Expected issuer "${issuer}".` };
  }
  if (p.aud !== audience) {
    return { ok: false, refusal: 'WRONG_AUDIENCE', detail: `Expected audience "${audience}".` };
  }
  if (p.exp + CLOCK_SKEW_TOLERANCE_S < nowSec) {
    return { ok: false, refusal: 'EXPIRED', detail: 'The assertion has expired.' };
  }
  if (p.iat - CLOCK_SKEW_TOLERANCE_S > nowSec) {
    return { ok: false, refusal: 'NOT_YET_VALID', detail: 'The assertion is not valid yet.' };
  }
  // S3 security review item 3: never trust the token's own iat/exp spread — an issuer that is
  // compromised, misconfigured, or simply changes its TTL later could mint a much longer-lived
  // window otherwise. Independently enforce FINAL_OS's <=60s ceiling on the RECEIVING side.
  if (p.exp - p.iat > MAX_ASSERTION_WINDOW_S) {
    return {
      ok: false, refusal: 'WINDOW_TOO_LONG',
      detail: `The assertion's exp-iat window (${p.exp - p.iat}s) exceeds the ${MAX_ASSERTION_WINDOW_S}s ceiling.`,
    };
  }
  if (expectedTargets && expectedTargets.length > 0 && !expectedTargets.includes(p.target)) {
    return {
      ok: false, refusal: 'WRONG_TARGET',
      detail: `This deployment does not serve the "${p.target}" console.`,
    };
  }
  if (expectedTenantId && (p.tenant_id !== expectedTenantId || p.org_id !== expectedTenantId)) {
    return {
      ok: false, refusal: 'WRONG_TENANT',
      detail: `Expected tenant/org "${expectedTenantId}".`,
    };
  }

  return {
    ok: true,
    claims: {
      iss: p.iss, aud: p.aud, sub: p.sub, tenant_id: p.tenant_id, org_id: p.org_id,
      email: p.email, roles: p.roles, target: p.target, jti: p.jti, iat: p.iat, exp: p.exp,
      auth_time: p.auth_time,
    },
  };
}
