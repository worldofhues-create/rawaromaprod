/**
 * ScaleController (lane pf-c, plan 12.5).
 *   POST /v1/device-agent/scale-readings {raw} | {mg, stable}   a paired scale's reading (stable only kept)   device token
 *   GET  /v1/scales/latest?station=                             the station's fresh stable reading             any signed-in person
 */
import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { AnyAuthenticated, CurrentUser, Public, type AuthPrincipal } from '@core/backend-kernel';
import { DevicesService } from './devices.service.js';
import { ScaleService } from './scale.service.js';

@Controller('v1')
export class ScaleController {
  constructor(private readonly scales: ScaleService, private readonly devices: DevicesService) {}

  /** Public to the user guard; authenticated by the scale's station-scoped device token. */
  @Public()
  @Post('device-agent/scale-readings')
  async record(@Headers('x-device-token') token: string, @Body() body: Record<string, unknown>) {
    return this.scales.record(await this.devices.authenticate(token), body ?? {});
  }

  @AnyAuthenticated('a station shows the weight on its own scale; a weight carries no formula or price')
  @Get('scales/latest')
  async latest(@Query('station') station?: string) {
    if (!station) throw new BadRequestException('station is required.');
    return { reading: await this.scales.latest(station) };
  }

  /** FLOOR-FIX-3: a typed weight needs a second person. The typist asks... */
  @AnyAuthenticated('the typist asks for a sign-off on a weight they typed; a weight carries no formula or price')
  @Post('scales/typed-checks')
  requestTypedCheck(@Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.scales.requestTypedCheck(body ?? {}, p);
  }

  @AnyAuthenticated('the list a verifier or supervisor signs from: station, figure and reason, no formula or price')
  @Get('scales/typed-checks')
  pendingTypedChecks(@Query('station') station?: string) {
    return this.scales.pendingTypedChecks(station ?? null);
  }

  /** ...and a verifier, supervisor or admin who did not type it signs (the role is checked in the service). */
  @AnyAuthenticated('signing is limited to verifier, supervisor and admin roles by ScaleService.signTypedCheck')
  @Post('scales/typed-checks/:id/sign')
  signTypedCheck(@Param('id') id: string, @CurrentUser() p: AuthPrincipal) {
    return this.scales.signTypedCheck(id, p);
  }
}
