/**
 * ShelfController — racks, put-away, picks and the shelf display (lane produce, owner requirement
 * + decisions 2026-09-29). Warehouse staff own the shelves (`location:*`); every location reader
 * (production, packaging, compounding, filling, sales, procurement, receiving, owner) sees the
 * tasks and the display. The pick-to-light controller is a connector: configured by the same
 * admins who configure the ALEMBIC bridge (`platform:flag:write`), no .env, no redeploy.
 */
import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Permissions, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { bridge as bridgeContracts } from '@core/contracts';
import { ShelfLayoutService } from './shelf-layout.service.js';
import { ShelfTaskService } from './shelf-task.service.js';
import { PickLightConfigError, PickLightService } from './pick-light.service.js';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? null : String(v));

@Controller()
export class ShelfController {
  constructor(
    private readonly layout: ShelfLayoutService,
    private readonly tasks: ShelfTaskService,
    private readonly lights: PickLightService,
  ) {}

  /* ── the location master (racks entered in the app) ─────────────────────────────────── */

  @Permissions('location:bin_master:read')
  @Get('v1/shelf/locations')
  locations(@Query('zone') zone?: string) {
    return this.layout.locations(zone || null);
  }

  @Permissions('location:shelf_task:read')
  @Get('v1/shelf/bin-stock')
  binStock(@Query('code') code?: string) {
    return this.tasks.binStock(code ?? '');
  }

  @Permissions('location:bin_master:read')
  @Get('v1/shelf/resolve')
  resolve(@Query('code') code?: string) {
    return this.layout.resolve(code ?? '');
  }

  @Permissions('location:rack_master:write', 'location:shelf_master:write', 'location:bin_master:write')
  @Post('v1/shelf/layout/rack')
  quickRack(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.layout.quickRack({
      zoneCode: String(body?.zoneCode ?? ''), zoneName: str(body?.zoneName), rackCode: String(body?.rackCode ?? ''),
      rackName: str(body?.rackName), shelves: Number(body?.shelves), binsPerShelf: Number(body?.binsPerShelf),
      walkSeq: body?.walkSeq === undefined || body?.walkSeq === null || body?.walkSeq === '' ? null : Number(body.walkSeq),
    }, principal);
  }

  @Permissions('location:rack_master:write', 'location:shelf_master:write', 'location:bin_master:write')
  @Post('v1/shelf/layout/import')
  importCsv(@Body() body: { csv?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    return this.layout.importCsv(String(body?.csv ?? ''), principal);
  }

  @Permissions('location:rack_master:write')
  @Put('v1/shelf/racks/:code/walk')
  setWalk(@Param('code') code: string, @Body() body: { walkSeq?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    return this.layout.setWalk(code, Number(body?.walkSeq), principal);
  }

  /* ── tasks ──────────────────────────────────────────────────────────────────────────── */

  @Permissions('location:shelf_task:read')
  @Get('v1/shelf/tasks')
  list(@Query('status') status?: string, @Query('kind') kind?: string, @Query('zone') zone?: string, @Query('rack') rack?: string) {
    return this.tasks.tasks({ status: status || null, kind: kind || null, zone: zone || null, rack: rack || null });
  }

  @Permissions('location:shelf_task:read')
  @Get('v1/shelf/tasks/scan')
  scan(@Query('code') code?: string) {
    return this.tasks.findByScan(code ?? '');
  }

  @Permissions('location:shelf_task:read')
  @Get('v1/shelf/ready')
  ready(@Query('limit') limit?: string) {
    return this.tasks.readyForPutaway(limit ? Number(limit) : 200);
  }

  @Permissions('location:shelf_task:write')
  @Post('v1/shelf/putaway')
  putaway(@Body() body: { finishedGoodBatchId?: unknown; binCode?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    const id = String(body?.finishedGoodBatchId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('finishedGoodBatchId is required.');
    return this.tasks.ensurePutaway(id, principal, { binCode: str(body?.binCode) });
  }

  @Permissions('location:shelf_task:write')
  @Post('v1/shelf/tasks/:id/putaway')
  completePutaway(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: { binCode?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    return this.tasks.completePutaway(id, String(body?.binCode ?? ''), principal);
  }

  @Permissions('location:shelf_task:read')
  @Get('v1/shelf/requirements')
  pickable() {
    return this.tasks.pickable();
  }

  @Permissions('location:shelf_task:write')
  @Post('v1/shelf/requirements/:id/picks')
  picksForRequirement(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.tasks.createPicks(id, principal);
  }

  @Permissions('location:shelf_task:write')
  @Post('v1/shelf/picks')
  pick(@Body() body: { finishedGoodBatchId?: unknown; binCode?: unknown; qty?: unknown; reference?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    const id = String(body?.finishedGoodBatchId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('finishedGoodBatchId is required.');
    return this.tasks.createPick({ finishedGoodBatchId: id, binCode: str(body?.binCode), qty: Number(body?.qty), reference: str(body?.reference) }, principal);
  }

  @Permissions('location:shelf_task:write')
  @Post('v1/shelf/tasks/:id/pick')
  completePick(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: { binCode?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    return this.tasks.completePick(id, String(body?.binCode ?? ''), principal);
  }

  @Permissions('location:shelf_task:write')
  @Post('v1/shelf/move')
  move(@Body() body: { finishedGoodBatchId?: unknown; fromBinCode?: unknown; toBinCode?: unknown; qty?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    const id = String(body?.finishedGoodBatchId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('finishedGoodBatchId is required.');
    return this.tasks.move({
      finishedGoodBatchId: id, fromBinCode: String(body?.fromBinCode ?? ''), toBinCode: String(body?.toBinCode ?? ''),
      qty: body?.qty === undefined || body?.qty === null || body?.qty === '' ? null : Number(body.qty),
    }, principal);
  }

  @Permissions('location:shelf_task:write')
  @Post('v1/shelf/tasks/:id/cancel')
  cancel(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.tasks.cancel(id, principal);
  }

  /* ── sheets + the shelf display ─────────────────────────────────────────────────────── */

  @Permissions('location:shelf_task:read')
  @Get('v1/shelf/sheet')
  sheet(@Query('kind') kind?: string, @Query('zone') zone?: string) {
    const k = String(kind ?? 'PUTAWAY').toUpperCase();
    if (k !== 'PUTAWAY' && k !== 'PICK') throw new BadRequestException('kind is PUTAWAY or PICK.');
    return this.tasks.sheet(k, zone || null);
  }

  @Permissions('location:shelf_task:read')
  @Get('v1/shelf/display')
  display(@Query('zone') zone?: string, @Query('rack') rack?: string) {
    return this.tasks.display(zone || null, rack || null);
  }

  /* ── pick-to-light (connector) ──────────────────────────────────────────────────────── */

  @Permissions('platform:flag:write')
  @Get('v1/shelf/pick-light')
  lightStatus() {
    return this.lights.status();
  }

  @Permissions('platform:flag:write')
  @Put('v1/shelf/pick-light/config')
  async configure(
    @Body(new ZodValidationPipe(bridgeContracts.configurePickLightRequest)) body: bridgeContracts.ConfigurePickLightRequest,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    try { return await this.lights.configure(body, principal.userId); }
    catch (err) { if (err instanceof PickLightConfigError) throw new BadRequestException(err.message); throw err; }
  }

  @Permissions('platform:flag:write')
  @Post('v1/shelf/pick-light/test')
  test(@Body() body: { binCode?: unknown }) {
    return this.lights.test(str(body?.binCode));
  }

  @Permissions('location:shelf_task:read')
  @Get('v1/shelf/pick-light/simulator')
  simulator() {
    return this.lights.simulatorState();
  }
}
