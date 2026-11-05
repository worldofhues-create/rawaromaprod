/**
 * DevicesController (lane pf-c, plan section 2).
 *
 * Admin (signed-in person):
 *   GET   /v1/devices                       the registry, online/offline           platform:device:read
 *   POST  /v1/devices {kind,station,name}   add a device -> 6-digit code + QR       platform:device:write
 *   POST  /v1/devices/:id/pairing-code      a fresh code (re-pair)                  platform:device:write
 *   PATCH /v1/devices/:id {name,station,config}                                     platform:device:write
 *   POST  /v1/devices/:id/revoke            instant unpair                          platform:device:write
 *   GET   /v1/floor/alerts?station=         open station alerts                     any signed-in person
 *   POST  /v1/floor/alerts/:id/ack                                                  any signed-in person
 *
 * Device (no person; X-Device-Token header, station-scoped):
 *   POST  /v1/device-agent/pair {code}      the code -> the device token, once      public (the code is the secret)
 *   POST  /v1/device-agent/heartbeat        every 60 s                              device token
 *   GET   /v1/device-agent/me               which station this device serves        device token
 */
import { Body, Controller, Get, Headers, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AnyAuthenticated, CurrentUser, Permissions, Public, PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { Inject } from '@nestjs/common';
import type { Sql } from 'postgres';
import { DevicesService } from './devices.service.js';
import { DisplayService } from './display.service.js';
import { ackAlert } from './floor-alerts.js';

@Controller('v1')
export class DevicesController {
  constructor(private readonly devices: DevicesService, @Inject(PG_CLIENT) private readonly sql: Sql, private readonly displaySvc: DisplayService) {}

  @Permissions('platform:device:read')
  @Get('devices')
  list() {
    return this.devices.list().then((items) => ({ items }));
  }

  @Permissions('platform:device:write')
  @Post('devices')
  create(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.devices.create(body ?? {}, principal);
  }

  @Permissions('platform:device:write')
  @Post('devices/:id/pairing-code')
  code(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.devices.newPairingCode(id, principal);
  }

  @Permissions('platform:device:write')
  @Patch('devices/:id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    return this.devices.update(id, body ?? {});
  }

  @Permissions('platform:device:write')
  @Post('devices/:id/revoke')
  revoke(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.devices.revoke(id, principal);
  }

  @AnyAuthenticated('the floor board (job numbers, stages, maceration days, QC backlog); coded, no formula or price')
  @Get('floor/display')
  board(@Query('station') station?: string) {
    return this.displaySvc.feed(station || null);
  }

  @AnyAuthenticated('every station screen shows its own alerts (printer offline, maceration complete); alerts carry no formula or price')
  @Get('floor/alerts')
  alerts(@Query('station') station?: string) {
    return this.devices.alerts(station || null).then((items) => ({ items }));
  }

  @AnyAuthenticated('the person at the station acknowledges an alert; the acknowledgement names them')
  @Post('floor/alerts/:id/ack')
  async ack(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    if (!(await ackAlert(this.sql, id, principal.userId, new Date()))) throw new NotFoundException('That alert is not open.');
    return { ok: true };
  }
}

@Controller('v1/device-agent')
export class DeviceAgentController {
  constructor(private readonly devices: DevicesService, private readonly display: DisplayService) {}

  /** A paired TV's screen: queue, maceration timers, QC backlog, its station's alerts. Read-only. */
  @Public()
  @Get('display')
  async tv(@Headers('x-device-token') token: string) {
    const d = await this.devices.authenticate(token);
    if (d.kind !== 'display' && d.kind !== 'kiosk') throw new NotFoundException('Only a paired display or kiosk shows the floor board.');
    return this.display.feed(d.station);
  }

  /** Public by design: the device has no login. The 6-digit code (10 minutes, single use, throttled) is the credential. */
  @Public()
  @Post('pair')
  pair(@Body() body: Record<string, unknown>) {
    return this.devices.pair(body?.code, (body?.info as Record<string, unknown>) ?? undefined);
  }

  /** Public to the user guard; authenticated by the station-scoped device token instead. */
  @Public()
  @Post('heartbeat')
  async heartbeat(@Headers('x-device-token') token: string) {
    return this.devices.heartbeat(await this.devices.authenticate(token));
  }

  @Public()
  @Get('me')
  me(@Headers('x-device-token') token: string) {
    return this.devices.authenticate(token);
  }
}
