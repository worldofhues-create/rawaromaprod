/**
 * `@Permissions('iam:user:read', …)` — require these `domain:resource:action` strings
 * (validated against the contracts permission registry at the type level). `PermissionsGuard`
 * reads them via the Reflector and checks the caller's permission set. ALL listed
 * permissions must be held (AND).
 */
import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@core/contracts';
import { META_PERMISSIONS } from './metadata.keys.js';

export const Permissions = (
  ...permissions: Permission[]
): MethodDecorator & ClassDecorator => SetMetadata(META_PERMISSIONS, permissions);
