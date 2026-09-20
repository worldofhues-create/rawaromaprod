/**
 * `@Portal('admin', 'ops')` — restrict a route to specific portal audiences. The
 * `JwtAuthGuard` already verifies the token's `aud` claim is a valid portal; this
 * narrows a route to a subset (e.g. admin-only). A buyer token is useless against an
 * `@Portal('admin')` route even if a role check were bypassed (doc 05 §1 portal gating).
 */
import { SetMetadata } from '@nestjs/common';
import type { Portal as PortalName } from '@core/contracts';
import { META_PORTALS } from './metadata.keys.js';

export const Portal = (
  ...portals: PortalName[]
): MethodDecorator & ClassDecorator => SetMetadata(META_PORTALS, portals);
