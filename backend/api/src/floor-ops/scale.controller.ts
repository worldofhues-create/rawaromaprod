/**
 * ScaleController (lane pf-c, plan 12.5).
 *   POST /v1/device-agent/scale-readings {raw} | {mg, stable}   a paired scale's reading (stable only kept)   device token
 *   GET  /v1/scales/latest?station=                             the station's fresh stable reading             any signed-in person
 */
import { BadRequestException, Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import { AnyAuthenticated, Public } from '@core/backend-kernel';
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
}
