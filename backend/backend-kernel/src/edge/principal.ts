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
   * When this access token was ISSUED (JWT `iat`, unix seconds) — NOT when the session
   * started. A refreshed/re-minted token gets a fresh `iat`, so re-entering credentials
   * (`POST /auth/login` again) is what moves this forward. `FreshAuthGuard` reads it to
   * enforce §109.5's fresh-authentication window on high-risk plaintext/decrypt routes.
   */
  iat: number;
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
