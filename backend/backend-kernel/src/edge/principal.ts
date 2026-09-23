/**
 * AuthPrincipal — the verified caller, attached to `request.user` by `JwtAuthGuard` and
 * read back by `@CurrentUser()`. Derived from the JWT claims, never from the request body.
 */
import type { Portal } from '@core/contracts';

export interface AuthPrincipal {
  /** iam.users.id (JWT `sub`). */
  userId: string;
  /** Portal audience claim (`aud`). */
  portal: Portal;
  /** Role keys carried in the token. */
  roles: string[];
  /** Flattened `domain:resource:action` permission strings. */
  permissions: string[];
  /** Permission-version stamp — lets us reject tokens minted before a role change. */
  permVersion: number;
  /** The active session id (JWT `sid`), for revoke checks. */
  sessionId: string;
  /**
   * When this access token was ISSUED (JWT `iat`, unix seconds) — NOT when the underlying
   * credential was proved. A refreshed/re-minted token always gets a fresh `iat`, which is
   * exactly why `FreshAuthGuard` must NOT read this field for step-up (S3 security review
   * item 2) — see `authTime` below.
   */
  iat: number;
  /**
   * When the credential behind this session was actually PROVED (OIDC `auth_time`
   * semantics) — carried forward unchanged across every token refresh, unlike `iat`.
   * `FreshAuthGuard` reads THIS field to enforce §109.5's fresh-authentication window on
   * high-risk plaintext/decrypt routes: a caller who refreshed their access token five
   * times over six hours has an `iat` from moments ago but an `authTime` from six hours
   * ago, and it is the latter that answers "how long since this person actually proved who
   * they are".
   */
  authTime: number;
}

/** A Fastify request augmented with the verified principal. */
export interface RequestWithUser {
  user?: AuthPrincipal;
  /** correlation id set by RequestIdMiddleware. */
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  method?: string;
  url?: string;
}
