/**
 * PermissionsGuard — RBAC enforcement. Reads `@Permissions('domain:resource:action', …)`
 * via the Reflector and checks the principal holds ALL of them (AND). Runs after
 * `JwtAuthGuard`, so `request.user` is present (except `@Public()` routes, which this guard
 * also short-circuits — see below). `super_admin` short-circuits for ORDINARY permissions
 * (holds them implicitly) — but NEVER for a vault-sensitive permission (§107/§108/§109:
 * "super_admin/owner/admin get NO implicit vault plaintext"). A god-mode role must still hold
 * `formula:actual:read` (or any future `vault:*` permission) EXPLICITLY, granted only to the
 * roles Vault authority names for it (scripts/ra-roles.ts: `formulator`, `vault_approver`) —
 * fail closed. Portal gating is the JWT audience layer; this is the role layer.
 *
 * FAIL CLOSED (security review — this guard used to fail OPEN): a route carrying no
 * `@Permissions(...)` used to be let through unconditionally, on the unstated assumption that
 * "no decorator" meant "the author deliberately left this open." That assumption is exactly
 * the bug — a route can end up undecorated by omission (forgetting the decorator) just as
 * easily as by design, and this guard could not tell the two apart. Every route must now carry
 * an EXPLICIT access decision, one of:
 *
 *   `@Permissions(...)`      a static permission list (the common case, checked below)
 *   `@Public()`              no auth at all — checked first, short-circuits everything
 *   `@SelfService()`         acts only on the caller's own identity/session
 *   `@DynamicPermission(r)`  the SERVICE checks a per-resource permission the Reflector
 *                            can't see statically, and throws `ForbiddenException` itself
 *   `@AnyAuthenticated(r)`   deliberately open to every authenticated caller; the service
 *                            self-masks/filters output instead of denying
 *
 * A route with NONE of these is denied — see `route-inventory.test.ts` for the startup check
 * that enumerates every controller route and fails the build if one has no decision at all,
 * and `permissions-guard.test.ts` for the guard-level proof that an unmarked route is denied.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@core/contracts';
import {
  META_ANY_AUTHENTICATED,
  META_DYNAMIC_PERMISSION,
  META_PERMISSIONS,
  META_PUBLIC,
  META_SELF_SERVICE,
} from '../decorators/metadata.keys.js';
import { DomainError } from './domain-error.js';
import type { RequestWithUser } from './principal.js';
import { SECURITY_AUDIT_SINK, type SecurityAuditSink } from './security-audit-sink.js';

/**
 * Permission-code patterns that never benefit from a role's blanket/implicit grant, no
 * matter how privileged the role — matched by prefix so a new `vault:*` permission is
 * covered automatically, without editing this guard again. Kept as a naming CONVENTION
 * (not an import of `@ra/cluster-formula` constants) so this edge-layer package stays
 * domain-free; the formula cluster is the only current holder of the pattern.
 */
const NEVER_IMPLICIT_PATTERNS: RegExp[] = [/^vault:/, /^formula:actual:/];

function isNeverImplicit(permission: string): boolean {
  return NEVER_IMPLICIT_PATTERNS.some((re) => re.test(permission));
}

/**
 * Permission-code patterns whose DENIAL is itself security-relevant enough to write to the
 * tamper-evident audit chain (security review item 5) — vault plaintext, formula approval/
 * lock/access-policy decisions. A superset of NEVER_IMPLICIT_PATTERNS (which only covers
 * plaintext-read) because an approve/lock/access-policy attempt by an unauthorized caller is
 * exactly the kind of probing attempt §109.8's "allow/refuse result" exists to surface. Kept
 * narrow (not every ordinary 403 — e.g. a missing `procurement:*:read`) so the audit chain
 * isn't flooded with routine, non-sensitive permission mistakes.
 */
const AUDITABLE_DENIAL_PATTERNS: RegExp[] = [
  /^vault:/,
  /^formula:actual:/,
  /^formula:formula_approval:/,
  /^formula:formula_access_policy:/,
];

function isAuditableDenial(permission: string): boolean {
  return AUDITABLE_DENIAL_PATTERNS.some((re) => re.test(permission));
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(SECURITY_AUDIT_SINK) private readonly auditSink?: SecurityAuditSink,
  ) {}

  // Deliberately SYNCHRONOUS (not async) — every other caller of this guard's canActivate in
  // the existing test suite (production-role.test.ts, platform-ops.test.ts,
  // permissions-guard.test.ts, vault-rbac.test.ts, material-search.test.ts) asserts on it
  // synchronously (`assert.equal(guard.canActivate(...), true)` /
  // `assert.throws(() => guard.canActivate(...), ...)`). The audit write (item 5) is
  // therefore fired-and-forgotten rather than awaited: it never delays or changes the 403,
  // and a write failure is swallowed the same way an awaited one would be — this file only
  // trades "audit row guaranteed to exist before the response is sent" for "guard stays
  // synchronous", which the security review's requirement ("write an audit row") does not
  // depend on.
  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const klass = context.getClass();

    // `@Public()` opts all the way out — no auth, no permission. Checked first so it never
    // even looks at `request.user`, which `JwtAuthGuard` may not have populated for it.
    const isPublic = this.reflector.getAllAndOverride<boolean>(META_PUBLIC, [handler, klass]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    const required = this.reflector.getAllAndOverride<Permission[]>(META_PERMISSIONS, [
      handler,
      klass,
    ]);

    if (!required || required.length === 0) {
      // No static permission list. FAIL CLOSED unless the route explicitly documents why —
      // one of the markers below — rather than treating the omission itself as consent.
      const isSelfService = this.reflector.getAllAndOverride<boolean>(META_SELF_SERVICE, [
        handler,
        klass,
      ]);
      const dynamicReason = this.reflector.getAllAndOverride<string>(META_DYNAMIC_PERMISSION, [
        handler,
        klass,
      ]);
      const anyAuthReason = this.reflector.getAllAndOverride<string>(META_ANY_AUTHENTICATED, [
        handler,
        klass,
      ]);
      const hasDecision = isSelfService || Boolean(dynamicReason) || Boolean(anyAuthReason);

      if (!user) {
        throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'Authentication required');
      }
      if (hasDecision) return true;

      // No decision at all — this is the bug class the fail-open guard used to hide. Deny, and
      // always audit it (unlike the ordinary missing-permission case below, which is only
      // audited for vault/formula-decision codes): a route reaching here means either a real
      // attacker probing an endpoint, or a developer who forgot a decorator — either way, worth
      // a permanent record rather than a silent 403.
      if (this.auditSink) {
        void this.auditSink
          .record({
            actorId: user.userId,
            action: 'security.permission.no_decision',
            entityType: 'permission',
            entityId: null,
            reason: `${klass?.name ?? 'UnknownController'}.${String(handler?.name ?? 'unknownHandler')} has no @Permissions/@Public/@SelfService/@DynamicPermission/@AnyAuthenticated`,
            requestId: request.requestId ?? null,
            ip: request.ip ?? null,
            result: 'refuse',
          })
          .catch(() => {
            // Same rule as every other audit write here: never let a logging failure change
            // or delay the 403 that was already happening.
          });
      }
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        `${klass?.name ?? 'This'}.${String(handler?.name ?? 'route')} has no access decision — `
          + 'add @Permissions(...), @Public(), @SelfService(), @DynamicPermission(reason), or '
          + '@AnyAuthenticated(reason).',
      );
    }

    if (!user) {
      throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'Authentication required');
    }

    const held = new Set(user.permissions);
    const isSuperAdmin = user.roles.includes('super_admin');
    const missing = required.filter((p) => {
      if (held.has(p)) return false;
      // The blanket bypass covers ordinary permissions only — a vault-sensitive one must
      // always be held explicitly, super_admin included.
      if (isSuperAdmin && !isNeverImplicit(p)) return false;
      return true;
    });
    if (missing.length > 0) {
      const auditable = missing.filter(isAuditableDenial);
      if (auditable.length > 0 && this.auditSink) {
        // entityId is a real `uuid` column (packages/data-kernel/src/audit.ts) — a permission
        // CODE is not one, so it goes in `reason` (free-text, non-hashed `after` jsonb)
        // instead, same as every other human-readable audit annotation.
        void this.auditSink
          .record({
            actorId: user.userId,
            action: 'security.permission.denied',
            entityType: 'permission',
            entityId: null,
            reason: `missing: ${auditable.join(', ')}`,
            requestId: request.requestId ?? null,
            ip: request.ip ?? null,
            result: 'refuse',
          })
          .catch(() => {
            // Never let an audit-write failure surface as anything other than the 403 that
            // was already happening.
          });
      }
      throw DomainError.forbidden('AUTH_FORBIDDEN', `Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
