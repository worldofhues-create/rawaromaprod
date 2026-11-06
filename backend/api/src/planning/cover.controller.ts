/** PROD-D-4 — order intelligence routes (plan 11, 12.9). Read: the live suggestion list with its
 *  reasoning and the planning.cover status. Write: approve / dismiss a suggestion (a person decides),
 *  flag an ALEMBIC order recurring or excluded. The service recomputes on every decision. */
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { CoverService } from './cover.service.js';

type B = Record<string, unknown>;

@Controller()
export class CoverController {
  constructor(private readonly cover: CoverService) {}

  @Permissions('production:cover_plan:read')
  @Get('v1/planning/cover')
  async list(@Query('sku') sku?: string) {
    const r = await this.cover.compute({ sku: sku || null });
    return { ...r, decided: await this.cover.decided(30) };
  }

  @Permissions('production:cover_plan:write')
  @Post('v1/planning/cover/approve')
  approve(@Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.cover.approve(b ?? {}, p); }

  @Permissions('production:cover_plan:write')
  @Post('v1/planning/cover/dismiss')
  dismiss(@Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.cover.dismiss(b ?? {}, p); }

  @Permissions('production:cover_plan:write')
  @Post('v1/planning/cover/order-flags')
  flag(@Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.cover.flagOrder(b ?? {}, p); }
}
