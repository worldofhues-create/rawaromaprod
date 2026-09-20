/**
 * FlagsController — `GET /v1/flags/snapshot` (public, read-only, portal-scoped) and the
 * admin `PUT /v1/admin/flags/:key` kill-switch toggler (doc 06 §2). The admin route
 * requires `platform:flag:write`; critical-flag 2FA step-up is layered on top later
 * (doc 05 §0.1). The snapshot endpoint is what web bootstraps from before opening the
 * SSE stream.
 */
import { Body, Controller, Get, Param, Put, UsePipes } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  Public,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { platform, type FlagSnapshot } from '@core/contracts';
import { z } from 'zod';
import { PlatformFlagsService, type SetFlagInput } from './flags.service.js';

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
  @Put('v1/admin/flags/:key')
  @UsePipes(new ZodValidationPipe(platform.flags.setFlagRequest))
  async setFlag(
    @Param('key') key: string,
    @Body() body: SetFlagBody,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<FlagSnapshot> {
    const input: SetFlagInput = {
      env: body.env,
      state: body.state,
      targeting: body.targeting ?? null,
      reason: body.reason,
    };
    return this.flags.setFlag(key, input, user.userId);
  }
}
