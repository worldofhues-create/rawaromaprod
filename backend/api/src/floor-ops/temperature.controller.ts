/**
 * TemperatureController (FLOOR-TEMP-1).
 *   GET  /v1/temperature/zones                     zones, last reading, due / overdue    quality:temperature:read
 *   GET  /v1/temperature/zones/:id/readings        the zone's log, newest first           quality:temperature:read
 *   POST /v1/temperature/zones/:id/readings {tempC, note}  a manual reading (server time)  quality:temperature:write
 *   POST /v1/temperature/zones {code, name, kind, logIntervalMin, bins}                   quality:storage_zone:write
 *   POST /v1/temperature/zones/:id/bins {bin}                                              quality:storage_zone:write
 *   GET  /v1/temperature/limits                    current sourced limits                  quality:temperature_limit:write
 *   PUT  /v1/temperature/limits/:materialId {minC, maxC, source}                           quality:temperature_limit:write
 *   POST /v1/temperature/limits {materialCode, minC, maxC, source}                         quality:temperature_limit:write
 *   POST /v1/device-agent/temperature-readings {tempC}   a paired temp_sensor, its own zone   device token
 */
import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Permissions, Public, type AuthPrincipal } from '@core/backend-kernel';
import { TemperatureService } from './temperature.service.js';
import { DevicesService } from './devices.service.js';

@Controller('v1/temperature')
export class TemperatureController {
  constructor(private readonly t: TemperatureService) {}

  @Permissions('quality:temperature_limit:write')
  @Post('limits')
  setLimitByCode(@Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.t.setLimitByCode({ materialCode: b?.materialCode, minC: b?.minC, maxC: b?.maxC, source: b?.source }, p);
  }

  @Permissions('quality:temperature:read')
  @Get('zones')
  zones() { return this.t.zones().then((items) => ({ items })); }

  @Permissions('quality:temperature:read')
  @Get('zones/:id/readings')
  readings(@Param('id', new ParseUUIDPipe()) id: string, @Query('limit') limit?: string) { return this.t.readings(id, Number(limit) || 50); }

  @Permissions('quality:temperature:write')
  @Post('zones/:id/readings')
  record(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.t.recordReading(id, { tempC: b?.tempC, note: b?.note }, p);
  }

  @Permissions('quality:storage_zone:write')
  @Post('zones')
  createZone(@Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) { return this.t.createZone(b ?? {}, p); }

  @Permissions('quality:storage_zone:write')
  @Post('zones/:id/bins')
  addBin(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) { return this.t.addBin(id, b?.bin, p); }

  @Permissions('quality:temperature_limit:write')
  @Get('limits')
  limits() { return this.t.limits(); }

  @Permissions('quality:temperature_limit:write')
  @Put('limits/:materialId')
  setLimit(@Param('materialId', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.t.setLimit(id, { minC: b?.minC, maxC: b?.maxC, source: b?.source }, p);
  }
}

/** FLOOR-TEMP-1, the sensor adapter. Public to the user guard; authenticated by the sensor's device token
 *  (the same pairing as scales, printers and TVs). The zone is the one the device is configured for. */
@Controller('v1')
export class TemperatureAgentController {
  constructor(private readonly t: TemperatureService, private readonly devices: DevicesService) {}

  @Public()
  @Post('device-agent/temperature-readings')
  async record(@Headers('x-device-token') token: string, @Body() body: Record<string, unknown>) {
    return this.t.recordSensorReading(await this.devices.authenticate(token), { tempC: body?.tempC });
  }
}
