/**
 * JwtService — sign + verify access/refresh tokens with `jose` (HS256).
 *
 * Access token (15m default): carries `sub` (userId), `aud` (portal), `roles`, `perms`,
 * `pv` (permission version), `sid` (session id) — everything the edge guards need with
 * zero DB hit (doc 05 §1). Refresh token (30d): minimal (`sub`, `sid`, `typ: refresh`) —
 * the rotating-refresh material itself is stored hashed in `iam.sessions`; this token is
 * just the bearer the client presents. Asymmetric keys are a drop-in (swap `signToken`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Portal } from '@core/contracts';
import { ConfigService } from '../config/config.service.js';
import { DomainError } from './domain-error.js';

export interface AccessClaims {
  sub: string;
  portal: Portal;
  roles: string[];
  perms: string[];
  pv: number;
  sid: string;
  /** When this token was issued (unix seconds). Set by `jose` via `setIssuedAt()`; surfaced
   * on verify so `FreshAuthGuard` can measure token age for step-up-gated routes (§109.5). */
  iat: number;
}

export interface RefreshClaims {
  sub: string;
  sid: string;
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
   * whole point: a caller can't backdate its own freshness. */
  async signAccess(claims: Omit<AccessClaims, 'iat'>): Promise<string> {
    return new SignJWT({
      portal: claims.portal,
      roles: claims.roles,
      perms: claims.perms,
      pv: claims.pv,
      sid: claims.sid,
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
    return new SignJWT({ sid: claims.sid, typ: 'refresh' })
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
      perms: asStringArray(payload.perms),
      pv: typeof payload.pv === 'number' ? payload.pv : 0,
      sid: typeof payload.sid === 'string' ? payload.sid : '',
      // `jose` always stamps `iat` when `.setIssuedAt()` was used to sign (every access token
      // this service mints). 0 (1970) for a token from elsewhere — reads as maximally stale,
      // never as fresh, so a malformed/foreign token can't pass a freshness check by omission.
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
    };
  }

  /** Verify + decode a refresh token. */
  async verifyRefresh(token: string): Promise<RefreshClaims> {
    const payload = await this.verify(token);
    if (payload.typ !== 'refresh' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'Malformed refresh token');
    }
    return { sub: payload.sub, sid: payload.sid };
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
