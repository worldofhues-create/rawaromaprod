/**
 * PermissionsGuard — RBAC enforcement. Reads `@Permissions('domain:resource:action', …)`
 * via the Reflector and checks the principal holds ALL of them (AND). Runs after
 * `JwtAuthGuard`, so `request.user` is present. `super_admin` short-circuits for ORDINARY
 * permissions (holds them implicitly) — but NEVER for a vault-sensitive permission
 * (§107/§108/§109: "super_admin/owner/admin get NO implicit vault plaintext"). A god-mode
 * role must still hold `formula:actual:read` (or any future `vault:*` permission)
 * EXPLICITLY, granted only to the roles Vault authority names for it (scripts/ra-roles.ts:
 * `formulator`, `vault_approver`) — fail closed. Portal gating is the JWT audience layer;
 * this is the role layer.
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
import { META_PERMISSIONS } from '../decorators/metadata.keys.js';
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
    const required = this.reflector.getAllAndOverride<Permission[]>(META_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
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
