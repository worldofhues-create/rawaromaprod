/**
 * `@DynamicPermission('reason')` — no static `@Permissions(...)` exists because the required
 * permission code depends on a route param the `Reflector` can't see (e.g. PATCH
 * `/v1/masters/:resource/:id`, where the permission is `REGISTRY[resource].perm`). The SERVICE
 * performs its own permission check and throws `ForbiddenException` before any read/write.
 * `PermissionsGuard` accepts this marker as the route's access decision in place of a static
 * permission list, but only as a documented, verified exception — the `reason` string is
 * required so the marker can't be reached for as a silent bypass; put the exact permission
 * code(s) and the service method that checks them.
 *
 * If you're tempted to reach for this because you haven't wired up the real permission check
 * yet, don't — check it in the service FIRST, then mark the route.
 */
import { SetMetadata } from '@nestjs/common';
import { META_DYNAMIC_PERMISSION } from './metadata.keys.js';

export const DynamicPermission = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata(META_DYNAMIC_PERMISSION, reason);
