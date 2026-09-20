/**
 * JwtAuthGuard — the first edge gate. Verifies the Bearer access token, confirms its
 * portal audience is one of the registered portals, and attaches the `AuthPrincipal` to
 * the request. Routes marked `@Public()` skip it. Portal-audience narrowing for a
 * specific route is enforced separately by reading `@Portal(...)` here too, so an admin
 * route rejects a buyer token at the audience layer (doc 05 §1).
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PORTALS, type Portal } from '@core/contracts';
import { META_PORTALS, META_PUBLIC } from '../decorators/metadata.keys.js';
import { DomainError } from './domain-error.js';
import { JwtService } from './jwt.service.js';
import type { AuthPrincipal, RequestWithUser } from './principal.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(META_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = extractBearer(request.headers['authorization']);
    if (!token) {
      throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'Missing bearer token');
    }

    const claims = await this.jwt.verifyAccess(token);

    if (!isKnownPortal(claims.portal)) {
      throw DomainError.unauthorized('AUTH_PORTAL_MISMATCH', 'Unknown portal audience');
    }

    // Route-level portal narrowing (e.g. @Portal('admin')).
    const allowedPortals = this.reflector.getAllAndOverride<Portal[]>(META_PORTALS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowedPortals && allowedPortals.length > 0 && !allowedPortals.includes(claims.portal)) {
      throw DomainError.forbidden('AUTH_PORTAL_MISMATCH', 'Token not valid for this portal');
    }

    const principal: AuthPrincipal = {
      userId: claims.sub,
      portal: claims.portal,
      roles: claims.roles,
      permissions: claims.perms,
      permVersion: claims.pv,
      sessionId: claims.sid,
    };
    request.user = principal;
    return true;
  }
}

function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const [scheme, token] = value.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function isKnownPortal(portal: string): portal is Portal {
  return (PORTALS as readonly string[]).includes(portal);
}
