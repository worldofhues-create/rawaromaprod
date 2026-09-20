/**
 * PermissionsGuard — RBAC enforcement. Reads `@Permissions('domain:resource:action', …)`
 * via the Reflector and checks the principal holds ALL of them (AND). Runs after
 * `JwtAuthGuard`, so `request.user` is present. `super_admin` short-circuits (holds every
 * permission implicitly). Portal gating is the JWT audience layer; this is the role layer.
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
    if (user.roles.includes('super_admin')) return true;

    const held = new Set(user.permissions);
    const missing = required.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw DomainError.forbidden('AUTH_FORBIDDEN', `Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
