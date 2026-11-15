/**
 * RP-BE-1 (ALEMBIC LD-261) — @NoRelay(): a route a session minted from ALEMBIC's server-side relay can
 * never reach, whatever permissions or step-up it carries.
 *
 * The rule it enforces: a decrypted formula (ingredients with quantities or percentages) and new formula
 * lines never pass through ALEMBIC. They are served only by RawProd's own Vault surface, to a person
 * signed in there (the browser hand-off, or a RawProd login). The relay marks its assertion `via:
 * "relay"`; the exchange carries that into the access token (`via`) and into `AuthPrincipal.via`; this
 * guard refuses such a principal with 403 before the handler runs. A token without the mark is a
 * hand-off or a RawProd login and is judged by the route's ordinary permission and @FreshAuth.
 *
 * Applied per route (UseGuards), after the global JwtAuthGuard has set `request.user`, so it needs no
 * registration in either process's module.
 */
import { applyDecorators, type CanActivate, type ExecutionContext, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { DomainError } from '../edge/domain-error.js';
import type { AuthPrincipal } from '../edge/principal.js';

export const META_NO_RELAY = 'core:noRelay';
export const NO_RELAY_MESSAGE = "This is opened only on the Vault itself, never through RAC OS. Open it in the Vault.";

@Injectable()
export class NoRelayGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: AuthPrincipal }>().user;
    if (user?.via === 'relay') throw DomainError.forbidden('AUTH_FORBIDDEN', NO_RELAY_MESSAGE);
    return true;
  }
}

export const NoRelay = (): MethodDecorator => applyDecorators(SetMetadata(META_NO_RELAY, true), UseGuards(NoRelayGuard)) as MethodDecorator;
