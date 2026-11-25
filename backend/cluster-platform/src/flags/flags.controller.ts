/**
 * FlagsController — `GET /v1/flags/snapshot` (public, read-only, portal-scoped), the
 * admin `GET /v1/admin/flags` owner's read and the admin `PUT /v1/admin/flags/:key`
 * kill-switch toggler (doc 06 §2). Both admin routes require `platform:flag:write` (the only
 * flag permission the role table grants: owner and platform_super_admin). The snapshot
 * endpoint is what web bootstraps from before opening the SSE stream.
 *
 * FEATURE-SWITCHES: a CRITICAL key (`all.auth`, `all.payments`, `admin.flags.write`) needs a
 * sign-in made in the last five minutes, the same window `@FreshAuth()` applies (doc 05 §0.1
 * said "layered on top later"; it is here now). It is checked per key rather than with the
 * route decorator, so changing an ordinary switch does not ask for a fresh code. Reached from
 * RAC OS through the relay, the relay asks a step-up first and the assertion carries its time.
 */
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  CurrentUser,
  DomainError,
  Permissions,
  Public,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { platform, type FlagSnapshot } from '@core/contracts';
import { z } from 'zod';
import { PlatformFlagsService, type AdminFlagsResponse, type SetFlagInput, type SetFlagResult } from './flags.service.js';

/** The window a critical switch's sign-in must fall inside (FreshAuthGuard's default). */
export const CRITICAL_FRESH_SECONDS = 300;

type SetFlagBody = z.infer<typeof platform.flags.setFlagRequest>;

interface SnapshotResponse {
  portal: string;
  flags: FlagSnapshot[];
  version: string;
}

@Controller()
export class FlagsController {
  constructor(private readonly flags: PlatformFlagsService) {}

  @Public()
  @Get('v1/flags/snapshot')
  snapshot(): SnapshotResponse {
    return {
      portal: 'all',
      flags: this.flags.list(),
      version: this.flags.versionTag,
    };
  }

  @Permissions('platform:flag:write')
  @Get('v1/admin/flags')
  adminList(): Promise<AdminFlagsResponse> {
    return this.flags.adminList();
  }

  @Permissions('platform:flag:write')
  @Put('v1/admin/flags/:key')
  async setFlag(
    @Param('key') key: string,
    // On the body alone: @UsePipes also ran the schema over the key, so every change answered 422.
    @Body(new ZodValidationPipe(platform.flags.setFlagRequest)) body: SetFlagBody,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<SetFlagResult> {
    const critical = await this.flags.critical(key);
    if (critical === null) throw DomainError.notFound(`There is no switch called "${key}" on this system, so nothing was changed.`);
    if (critical) {
      const age = Math.floor(Date.now() / 1000) - user.authTime;
      if (!Number.isFinite(user.authTime) || age > CRITICAL_FRESH_SECONDS || age < -5) {
        throw DomainError.forbidden('AUTH_STEP_UP_REQUIRED', `"${key}" is a critical switch: sign in again (a fresh code) within five minutes of changing it. Nothing was changed.`);
      }
    }
    const input: SetFlagInput = {
      env: body.env,
      state: body.state,
      targeting: body.targeting ?? null,
      reason: body.reason,
    };
    return this.flags.setFlag(key, input, user.userId);
  }
}
