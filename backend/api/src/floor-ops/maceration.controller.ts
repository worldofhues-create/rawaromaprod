/**
 * MacerationController (lane pf-c, plan section 8).
 *   GET  /v1/maceration/settings                 per formula                          production:maceration:read
 *   PUT  /v1/maceration/settings/:formulaId      the admin toggle, min/max, freeze     production:maceration_setting:write
 *   GET  /v1/maceration/runs?all=1               open runs ("Day 23 of 45")            production:maceration:read
 *   GET  /v1/maceration/runs/:id                 one run with its log                  production:maceration:read
 *   POST /v1/maceration/runs/:id/freeze-done     the freeze / chill-filter step        production:maceration:write
 *   POST /v1/maceration/runs/:id/extend {days, reason}                                 production:maceration:write
 *   GET  /v1/maceration/rule                     PROM-2: the branch rule in force       production:maceration:read
 *   POST /v1/maceration/runs/:id/release-early {reasonCode, reason}  PROM-2: a REQUEST   production:maceration:release_early_request
 *   POST /v1/maceration/runs/:id/release-early/approve {note?}  a second person, fresh   production:maceration:release_early
 *   POST /v1/maceration/runs/:id/release-early/decline {reason}                          production:maceration:release_early
 *   QC 2 still gates the release after an approved early release.
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, FreshAuth, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { MacerationService } from './maceration.service.js';

@Controller('v1/maceration')
export class MacerationController {
  constructor(private readonly mac: MacerationService) {}

  @Permissions('production:maceration:read')
  @Get('settings')
  settings() { return this.mac.settings().then((items) => ({ items })); }

  @Permissions('production:maceration_setting:write')
  @Get('setting-products')
  settingProducts() { return this.mac.settingProducts().then((items) => ({ items })); }

  @Permissions('production:maceration_setting:write')
  @Put('settings/:formulaId')
  put(@Param('formulaId', new ParseUUIDPipe()) formulaId: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.mac.putSetting(formulaId, body ?? {}, p);
  }

  @Permissions('production:maceration:read')
  @Get('rule')
  rule() { return this.mac.rule(); }

  @Permissions('production:maceration:read')
  @Get('runs')
  runs(@Query('all') all?: string) { return this.mac.runs({ open: all === '1' ? false : true }).then((items) => ({ items })); }

  @Permissions('production:maceration:read')
  @Get('runs/:id')
  run(@Param('id', new ParseUUIDPipe()) id: string) { return this.mac.run(id); }

  @Permissions('production:maceration:write')
  @Post('runs/:id/freeze-done')
  freeze(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.mac.freezeDone(id, body ?? {}, p);
  }

  @Permissions('production:maceration:write')
  @Post('runs/:id/extend')
  extend(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.mac.extend(id, body ?? {}, p);
  }

  @Permissions('production:maceration:release_early_request')
  @Post('runs/:id/release-early')
  early(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.mac.requestEarlyRelease(id, body ?? {}, p);
  }

  @Permissions('production:maceration:release_early')
  @FreshAuth(300)
  @Post('runs/:id/release-early/approve')
  approveEarly(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.mac.approveEarlyRelease(id, body ?? {}, p);
  }

  @Permissions('production:maceration:release_early')
  @Post('runs/:id/release-early/decline')
  declineEarly(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.mac.declineEarlyRelease(id, body ?? {}, p);
  }
}
