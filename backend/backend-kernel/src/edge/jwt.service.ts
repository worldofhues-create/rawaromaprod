/**
 * JwtService — sign + verify access/refresh tokens with `jose` (HS256).
 *
 * Access token (15m default): carries `sub` (userId), `aud` (portal), `roles`, `pv`
 * (permission version), `sid` (session id), `authTime`, and `perms` holding ONLY the
 * vault-scoped subset (`formula:*`/`vault:*`, see `permission-resolver.ts`). It used to carry
 * every permission; an owner's 257 made a 12 KB token that nginx refused as a header. The rest
 * of the permission set is resolved server-side from `roles` by the process's
 * `PermissionResolver` (`JwtAuthGuard`). Refresh token (30d): minimal (`sub`, `sid`,
 * `typ: refresh`) — the rotating-refresh material itself is stored hashed in `iam.sessions`;
 * this token is just the bearer the client presents. Asymmetric keys are a drop-in (swap
 * `signToken`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Portal } from '@core/contracts';
import { ConfigService } from '../config/config.service.js';
import { DomainError } from './domain-error.js';
import { isTokenCarriedPermission } from './permission-resolver.js';

export interface AccessClaims {
  sub: string;
  portal: Portal;
  roles: string[];
  /** ONLY the vault-scoped subset (`isTokenCarriedPermission`): what the Vault box, which has
   *  no IAM tables to resolve roles against, checks. Never the full permission list. */
  perms: string[];
  pv: number;
  sid: string;
  /** When this token was issued (unix seconds). Set by `jose` via `setIssuedAt()`; surfaced
   * on verify so callers that genuinely need mint time can read it. */
  iat: number;
  /**
   * S3 security review item 2 — when the underlying credential was actually PROVED (OIDC
   * `auth_time` semantics), NOT when this particular access token was minted. For an ordinary
   * password login this equals `iat` (the login itself IS the proof). For a session minted via
   * the ALEMBIC assertion bridge, this is the assertion's own `auth_time` (the OTP-verification
   * time of the ALEMBIC session, or a fresh step-up time for Vault) — carried forward across
   * every `refresh()` re-mint rather than reset to "now", because a refresh re-presents an
   * existing session's bearer token, not a fresh proof of the credential. `FreshAuthGuard`
   * reads THIS field, never `iat`, to enforce §109.5's step-up window — see that guard's
   * header for why `iat` was the wrong field to have used.
   */
  authTime: number;
}

export interface RefreshClaims {
  sub: string;
  sid: string;
  /** Carried forward unchanged from the access token this refresh token was minted beside, so
   *  `AuthService.refresh()` can re-mint an access token whose `authTime` still reflects the
   *  ORIGINAL proof rather than the moment of refresh (S3 security review item 2). */
  authTime: number;
}

@Injectable()
export class JwtService {
  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    this.secret = new TextEncoder().encode(this.config.get('JWT_SECRET'));
    this.issuer = this.config.get('JWT_ISSUER');
    this.accessTtl = this.config.get('JWT_ACCESS_TTL');
    this.refreshTtl = this.config.get('JWT_REFRESH_TTL');
  }

  get accessTtlSeconds(): number {
    return this.accessTtl;
  }

  /** Sign an access token. `aud` = portal so the audience check is a JWT-native compare.
   * `iat` is NOT a caller-supplied input — `.setIssuedAt()` stamps "now" below, which is the
   * whole point: a caller can't backdate its own freshness. `authTime` IS caller-supplied
   * (S3 security review item 2) — unlike `iat`, it is not always "now": a refresh re-mint
   * must carry the ORIGINAL proof time forward, never stamp a fresh one. `perms` is narrowed
   * to the vault-scoped subset HERE, whatever the caller passes, so no caller can put the full
   * permission list (and the oversized header) back into a token. */
  async signAccess(claims: Omit<AccessClaims, 'iat'>): Promise<string> {
    return new SignJWT({
      portal: claims.portal,
      roles: claims.roles,
      perms: claims.perms.filter(isTokenCarriedPermission),
      pv: claims.pv,
      sid: claims.sid,
      authTime: claims.authTime,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setAudience(claims.portal)
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtl}s`)
      .sign(this.secret);
  }

  /** Sign a refresh token (opaque-ish bearer; the hash lives in the session row). */
  async signRefresh(claims: RefreshClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid, typ: 'refresh', authTime: claims.authTime })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setExpirationTime(`${this.refreshTtl}s`)
      .sign(this.secret);
  }

  /** Verify + decode an access token. Throws `DomainError` with the right code on failure. */
  async verifyAccess(token: string): Promise<AccessClaims> {
    const payload = await this.verify(token);
    const portal = payload.aud;
    if (typeof payload.sub !== 'string' || typeof portal !== 'string') {
      throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'Malformed access token');
    }
    return {
      sub: payload.sub,
      portal: portal as Portal,
      roles: asStringArray(payload.roles),
      // Narrowed on read too: a full-list token minted before this change still reads as the
      // vault-scoped subset, the same as one minted after it.
      perms: asStringArray(payload.perms).filter(isTokenCarriedPermission),
      pv: typeof payload.pv === 'number' ? payload.pv : 0,
      sid: typeof payload.sid === 'string' ? payload.sid : '',
      // `jose` always stamps `iat` when `.setIssuedAt()` was used to sign (every access token
      // this service mints). 0 (1970) for a token from elsewhere — reads as maximally stale,
      // never as fresh, so a malformed/foreign token can't pass a freshness check by omission.
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
      // Same "reads as maximally stale, never fresh" fallback as `iat` above — a token from
      // elsewhere (or signed before this claim existed) must never pass a step-up check by
      // omission (S3 security review item 2).
      authTime: typeof payload.authTime === 'number' ? payload.authTime : 0,
    };
  }

  /** Verify + decode a refresh token. */
  async verifyRefresh(token: string): Promise<RefreshClaims> {
    const payload = await this.verify(token);
    if (payload.typ !== 'refresh' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'Malformed refresh token');
    }
    return {
      sub: payload.sub,
      sid: payload.sid,
      authTime: typeof payload.authTime === 'number' ? payload.authTime : 0,
    };
  }

  private async verify(token: string): Promise<JWTPayload & Record<string, unknown>> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: this.issuer });
      return payload as JWTPayload & Record<string, unknown>;
    } catch (err) {
      const code =
        err instanceof Error && err.name === 'JWTExpired'
          ? 'AUTH_TOKEN_EXPIRED'
          : 'AUTH_TOKEN_INVALID';
      throw DomainError.unauthorized(code, 'Invalid or expired token');
    }
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
