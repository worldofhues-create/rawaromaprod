/**
 * `@SelfService()` — this route only ever acts on the CALLER'S OWN identity/session (reads
 * `@CurrentUser()`, never a `:userId`/`:id` param naming someone else). `PermissionsGuard`
 * accepts this as the route's access decision in place of `@Permissions(...)`: "logged in" IS
 * the authorization, because there's no other principal whose data could leak.
 *
 * Examples: `GET /v1/me`, `POST /v1/auth/logout`. Do NOT reach for this for a route that takes
 * a target id (e.g. `POST /auth/users/:id/password`) even if callers usually pass their own id
 * — use a real `@Permissions(...)` there, since nothing stops a caller passing someone else's id.
 */
import { SetMetadata } from '@nestjs/common';
import { META_SELF_SERVICE } from './metadata.keys.js';

export const SelfService = (): MethodDecorator & ClassDecorator => SetMetadata(META_SELF_SERVICE, true);
