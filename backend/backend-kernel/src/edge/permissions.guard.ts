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
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@core/contracts';
import { META_PERMISSIONS } from '../decorators/metadata.keys.js';
import { DomainError } from './domain-error.js';
import type { RequestWithUser } from './principal.js';

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

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

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
      throw DomainError.forbidden('AUTH_FORBIDDEN', `Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
