/**
 * LogisticsController + CourierController (lane pf-c, plan section 6 station 6, 9, 12.6).
 *   GET  /v1/logistics/queue                                  packed, waiting to ship          sales:shipment:read
 *   POST /v1/logistics/shipments/:id/cartons/scan {cartonCode}                                 sales:logistics:write
 *   POST /v1/logistics/shipments/:id/documents {station}      generated, printed               sales:logistics:write
 *   POST /v1/logistics/shipments/:id/awb {courierCode, awb, source: scan|typed, station}       sales:logistics:write
 *   POST /v1/logistics/shipments/:id/handover {handedTo}      HANDED OVER; Dispatched to ALEMBIC  sales:logistics:write
 *   POST /v1/logistics/shipments/:id/exception {kind, note?, cartonCode?, station}             sales:logistics:write
 *   GET  /v1/couriers                                         connectors (never credentials)   platform:courier_connector:read
 *   PUT  /v1/couriers/:provider {displayName, awbPattern, trackingUrlTemplate, mode?}          platform:courier_connector:write
 *   POST /v1/couriers/:provider/connect {credentials}         one-click Connect (sealed)       platform:courier_connector:write
 *   POST /v1/couriers/:provider/test | /disconnect | /mode {mode}                              platform:courier_connector:write
 */
import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { CourierService } from './courier.service.js';
import { LogisticsService } from './logistics.service.js';

function station(body: Record<string, unknown> | undefined): string {
  const s = typeof body?.station === 'string' ? body.station.trim().slice(0, 80) : '';
  if (!s) throw new BadRequestException('station is required (the logistics desk).');
  return s;
}

@Controller('v1/logistics')
export class LogisticsController {
  constructor(private readonly logistics: LogisticsService) {}

  @Permissions('sales:shipment:read')
  @Get('queue')
  queue() { return this.logistics.queue().then((items) => ({ items })); }

  @Permissions('sales:logistics:write')
  @Post('shipments/:id/cartons/scan')
  scan(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.logistics.checkCarton(id, body?.cartonCode, p);
  }

  @Permissions('sales:logistics:write')
  @Post('shipments/:id/documents')
  docs(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.logistics.documents(id, station(body), p);
  }

  @Permissions('sales:logistics:write')
  @Post('shipments/:id/awb')
  awb(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.logistics.assignAwb(id, body ?? {}, station(body), p);
  }

  @Permissions('sales:logistics:write')
  @Post('shipments/:id/handover')
  handover(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.logistics.handover(id, body ?? {}, p);
  }

  @Permissions('sales:logistics:write')
  @Post('shipments/:id/exception')
  exception(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.logistics.exception(id, body ?? {}, station(body), p);
  }
}

@Controller('v1/couriers')
export class CourierController {
  constructor(private readonly couriers: CourierService) {}

  @Permissions('platform:courier_connector:read')
  @Get()
  list() { return this.couriers.list().then((items) => ({ items })); }

  @Permissions('platform:courier_connector:write')
  @Put(':provider')
  upsert(@Param('provider') provider: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.couriers.upsert(provider, body ?? {}, p);
  }

  @Permissions('platform:courier_connector:write')
  @Post(':provider/connect')
  connect(@Param('provider') provider: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.couriers.connect(provider, body ?? {}, p);
  }

  @Permissions('platform:courier_connector:write')
  @Post(':provider/test')
  test(@Param('provider') provider: string) { return this.couriers.test(provider); }

  @Permissions('platform:courier_connector:write')
  @Post(':provider/disconnect')
  disconnect(@Param('provider') provider: string, @CurrentUser() p: AuthPrincipal) { return this.couriers.disconnect(provider, p); }

  @Permissions('platform:courier_connector:write')
  @Post(':provider/mode')
  mode(@Param('provider') provider: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.couriers.setMode(provider, body?.mode, p);
  }
}
