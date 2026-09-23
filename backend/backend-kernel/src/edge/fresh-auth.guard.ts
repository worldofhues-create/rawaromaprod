/**
 * FreshAuthGuard — the step-up enforcement gate (§109.5). Reads `@FreshAuth(maxAgeSeconds)`
 * and compares it against how long ago the caller's access token was ISSUED
 * (`principal.iat`, set by `JwtAuthGuard` from the verified JWT — never client-supplied).
 * Runs AFTER `PermissionsGuard` in the global chain (`app.module.ts`), so a caller who lacks
 * the underlying permission gets a plain 403 first; only a permission-holder presenting a
 * stale token is asked to step up. Unmarked routes (no `@FreshAuth`) are unaffected.
 *
 * Re-authenticating today means re-running `POST /auth/login` (the same password/OTP the
 * caller already has) — that mints a token with a new `iat`. This launch does not add a
 * second MFA factor (§109.5: "do not reintroduce an ordinary TOTP/MFA wizard to all staff").
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { META_FRESH_AUTH } from '../decorators/metadata.keys.js';
import { DomainError } from './domain-error.js';
import type { RequestWithUser } from './principal.js';
import { SECURITY_AUDIT_SINK, type SecurityAuditSink } from './security-audit-sink.js';

@Injectable()
export class FreshAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(SECURITY_AUDIT_SINK) private readonly auditSink?: SecurityAuditSink,
  ) {}

  // Synchronous, same reasoning as PermissionsGuard.canActivate — the audit write is
  // fire-and-forget so this guard's public contract (boolean, throws synchronously) never
  // changes shape for callers/tests.
  canActivate(context: ExecutionContext): boolean {
    const maxAgeSeconds = this.reflector.getAllAndOverride<number>(META_FRESH_AUTH, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (maxAgeSeconds === undefined) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    // JwtAuthGuard runs first in the global chain; no principal here means misconfiguration,
    // not a legitimate anonymous call — fail closed rather than silently pass.
    if (!user) {
      throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'Authentication required');
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - user.iat;
    // -5s tolerance absorbs ordinary clock skew between the signer and this process without
    // ever letting a real backdated/forged `iat` read as fresh.
    if (!Number.isFinite(user.iat) || ageSeconds > maxAgeSeconds || ageSeconds < -5) {
      // Every @FreshAuth()-gated route is, by construction, a vault/formula-decision route
      // (decrypt, approve, reject, lock) — so unlike PermissionsGuard, every denial here is
      // audit-worthy, not just a pattern-matched subset (security review item 5).
      if (this.auditSink) {
        // entityId is a real `uuid` column (packages/data-kernel/src/audit.ts) — the route
        // path is not one, so it goes in `reason` instead (same fix as PermissionsGuard).
        void this.auditSink
          .record({
            actorId: user.userId,
            action: 'security.freshauth.denied',
            entityType: 'route',
            entityId: null,
            reason: request.url ?? null,
            requestId: request.requestId ?? null,
            ip: request.ip ?? null,
            result: 'refuse',
          })
          .catch(() => {
            // Never let an audit-write failure mask the real 403.
          });
      }
      throw DomainError.forbidden(
        'AUTH_STEP_UP_REQUIRED',
        `Re-authenticate to continue — this action requires a session issued within the last ${maxAgeSeconds}s`,
      );
    }
    return true;
  }
}
