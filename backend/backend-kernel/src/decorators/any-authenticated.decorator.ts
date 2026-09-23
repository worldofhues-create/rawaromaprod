/**
 * `@AnyAuthenticated('reason')` — deliberately open to every authenticated caller, no
 * permission gate at all. Unlike `@DynamicPermission`, the service never throws
 * `ForbiddenException` for this route — it self-masks or role-filters what it RETURNS instead
 * of denying who may call it (e.g. the role dashboard: everyone gets a response, the content
 * differs by role/permission). `PermissionsGuard` accepts this marker as the route's access
 * decision in place of a static permission list, same as `@DynamicPermission`, but the `reason`
 * must say why NO permission check applies at all (not just why it can't be static) — that's a
 * stronger claim, so don't reach for this to paper over a route that should actually deny
 * someone; use `@DynamicPermission` for that.
 */
import { SetMetadata } from '@nestjs/common';
import { META_ANY_AUTHENTICATED } from './metadata.keys.js';

export const AnyAuthenticated = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata(META_ANY_AUTHENTICATED, reason);
