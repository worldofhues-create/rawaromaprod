/**
 * PackingController (lane pf-c, plan section 6, station 5). `station` names the packing bench, so
 * labels go to its paired printer and weights must come from its own scale.
 *   GET  /v1/packing/queue                         shipments being packed            sales:shipment:read
 *   GET  /v1/shipments/:id                         one shipment, cartons, units      sales:shipment:read
 *   POST /v1/packing/shipments {salesOrderId, finishedGoodBatchIds}                  packaging:packing_station:write
 *   POST /v1/packing/shipments/:id/units {finishedGoodBatchId, targetMg, toleranceMg, mg, weightSource, scaleReadingId?, sealed, station}
 *   POST /v1/packing/shipments/:id/cartons         open the next carton
 *   POST /v1/packing/cartons/:id/scan {unitCode}   a unit into the carton (wrong order/lot refused)
 *   POST /v1/packing/cartons/:id/close {mg, weightSource, scaleReadingId?, allowanceMg?, station}
 *   POST /v1/packing/shipments/:id/finish {station}  PACKED; carton labels + packing list print
 */
import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { PackingService } from './packing.service.js';

function station(body: Record<string, unknown> | undefined): string {
  const s = typeof body?.station === 'string' ? body.station.trim().slice(0, 80) : '';
  if (!s) throw new BadRequestException('station is required (the packing bench).');
  return s;
}

@Controller('v1')
export class PackingController {
  constructor(private readonly packing: PackingService) {}

  @Permissions('sales:shipment:read')
  @Get('packing/queue')
  queue() { return this.packing.queue().then((items) => ({ items })); }

  @Permissions('sales:shipment:read')
  @Get('shipments/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string) { return this.packing.shipment(id); }

  @Permissions('packaging:packing_station:write')
  @Post('packing/shipments')
  start(@Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) { return this.packing.start(body ?? {}, p); }

  @Permissions('packaging:packing_station:write')
  @Post('packing/shipments/:id/units')
  unit(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.packing.addUnit(id, body ?? {}, station(body), p);
  }

  @Permissions('packaging:packing_station:write')
  @Post('packing/shipments/:id/cartons')
  carton(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() p: AuthPrincipal) { return this.packing.openCarton(id, p); }

  @Permissions('packaging:packing_station:write')
  @Post('packing/cartons/:id/scan')
  scan(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.packing.scanUnit(id, body?.unitCode, p);
  }

  @Permissions('packaging:packing_station:write')
  @Post('packing/cartons/:id/close')
  close(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.packing.closeCarton(id, body ?? {}, station(body), p);
  }

  @Permissions('packaging:packing_station:write')
  @Post('packing/shipments/:id/finish')
  finish(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.packing.finish(id, station(body), p);
  }
}
