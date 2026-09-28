/**
 * The Factory and Platform consoles' "stay signed in across a reload" cookie (lane platform-roles,
 * 2026-09-28). The refresh token rides as an HttpOnly cookie that page JavaScript can never read,
 * instead of in localStorage (which any script on the page can read) or not at all (a reload
 * signed you out).
 *
 * The consoles talk to the API only through the encrypted tunnel (POST /rpc, crypto.controller.ts),
 * which replays each call internally and returns just its status + body. A Set-Cookie on the inner
 * /auth/* response would never reach the browser, so the tunnel itself sets and reads the cookie:
 *   - an /auth/alembic-assertion | /auth/login | /auth/refresh success, when the console asked for
 *     it (`persist: true` in the sealed request), sets the cookie and REMOVES `refreshToken` from
 *     the body the page sees;
 *   - /auth/refresh with no refreshToken in the body takes it from the cookie;
 *   - /auth/logout (tunnel-only) and a refused refresh clear it.
 *
 * Cookie: `__Secure-rawprod_rt`; HttpOnly; Secure; SameSite=Strict; Path=/rpc — sent only to the
 * tunnel endpoint of the one console host that set it, never to static files or another host.
 * SameSite does not separate sibling *.huecycle.in sites (ALEMBIC, the storefront), so the tunnel
 * also refuses to use or set it unless the request is same-origin (Sec-Fetch-Site / Origin).
 *
 * The Vault console never asks for persistence: its model is an in-memory session and a fresh
 * ALEMBIC step-up per visit (§109.4), and its sign-in channel is /main/rpc on the Vault host, so a
 * main-box refresh token must never be stored there.
 */

export const SESSION_COOKIE = '__Secure-rawprod_rt';
export const SESSION_COOKIE_PATH = '/rpc';

/** Inner routes whose result is a session ({ accessToken, refreshToken, user }). */
export const SESSION_ROUTES: ReadonlySet<string> = new Set(['/auth/alembic-assertion', '/auth/login', '/auth/refresh']);
/** Tunnel-only: clears the cookie. There is no inner route; refresh tokens are stateless, so
 *  signing out ends this browser's saved session (a copied token would still refresh until expiry). */
export const LOGOUT_ROUTE = '/auth/logout';

type Headers = Record<string, string | string[] | undefined>;

function header(h: Headers, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The saved refresh token from the request's Cookie header, or null. */
export function readSessionCookie(h: Headers): string | null {
  const raw = header(h, 'cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return v ? v : null;
    }
  }
  return null;
}

/** Seconds until the refresh token's own `exp` (30 days from the last sign-in or refresh).
 *  Only used for the cookie's Max-Age — the token is still verified on every refresh. */
export function secondsUntilExpiry(jwt: string, nowMs = Date.now()): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp === 'number') return Math.max(0, Math.floor(payload.exp - nowMs / 1000));
  } catch { /* fall through */ }
  return 0;
}

export function setSessionCookie(refreshToken: string, nowMs = Date.now()): string {
  return `${SESSION_COOKIE}=${refreshToken}; Max-Age=${secondsUntilExpiry(refreshToken, nowMs)}; Path=${SESSION_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=${SESSION_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;
}

/** True when this /rpc request came from a page on the console's own origin. A browser always
 *  sends Sec-Fetch-Site (or, if older, Origin on a POST); a request with neither is not a browser
 *  and carries no ambient cookie to abuse. */
export function isSameOriginRequest(h: Headers): boolean {
  const site = header(h, 'sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = header(h, 'origin');
  if (!origin) return true;
  const host = header(h, 'x-forwarded-host') ?? header(h, 'host');
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}
