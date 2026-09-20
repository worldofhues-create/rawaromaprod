/**
 * `@CurrentUser()` — inject the verified `AuthPrincipal` (or one of its fields) into a
 * handler param. Reads `request.user` that `JwtAuthGuard` set; never trusts the body.
 *
 *   @Get('me') me(@CurrentUser() user: AuthPrincipal) { … }
 *   @Get('me') me(@CurrentUser('userId') userId: string) { … }
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthPrincipal, RequestWithUser } from '../edge/principal.js';

export const CurrentUser = createParamDecorator(
  (field: keyof AuthPrincipal | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
