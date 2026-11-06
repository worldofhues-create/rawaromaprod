/**
 * PROD-A-4..6 — the floor's routes (production-floor plan §3, §5, §6, §12.2). Each station write is
 * its own permission (picker / verifier / mixer); the services re-check stage, order and
 * separation of duties on every call, so a person holding two floor roles still cannot verify
 * their own pick.
 */
import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { FloorCodeService } from './floor-code.service.js';
import { FloorStationService, type LabelKind } from './floor-station.service.js';
import { FloorQueueService } from './floor-queue.service.js';

const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

@Controller()
export class FloorController {
  constructor(
    private readonly codes: FloorCodeService,
    private readonly stations: FloorStationService,
    private readonly queue: FloorQueueService,
  ) {}

  /* ── colour table and floor codes ───────────────────────────────────────────────────── */

  @Permissions('masterdata:floor_code:read')
  @Get('v1/floor/families')
  families() {
    return this.codes.families();
  }

  @Permissions('masterdata:floor_family:write')
  @Put('v1/floor/families/:code')
  setFamily(@Param('code') code: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.codes.setFamily({ familyCode: code, familyName: s(b?.familyName), colourName: s(b?.colourName), colourHex: s(b?.colourHex), initial: b?.initial ? s(b.initial) : undefined }, p);
  }

  @Permissions('masterdata:floor_code:write')
  @Post('v1/floor/codes')
  assign(@Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    const materialId = s(b?.materialId);
    if (!/^[0-9a-f-]{36}$/i.test(materialId)) throw new BadRequestException('Choose a material.');
    return this.codes.assignCode(materialId, s(b?.familyCode), p);
  }

  @Permissions('masterdata:floor_code:write')
  @Get('v1/floor/codes/:materialId')
  codeFor(@Param('materialId', ParseUUIDPipe) materialId: string) {
    return this.codes.codeFor(materialId);
  }

  /* ── lots ───────────────────────────────────────────────────────────────────────────── */

  @Permissions('inventory:lot_barcode:write')
  @Post('v1/floor/lots/:id/barcode')
  async mintLot(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() p: AuthPrincipal) {
    const barcode = await this.codes.lotBarcode(id, p);
    return this.codes.resolve(barcode, p);
  }

  @Permissions('inventory:lot_barcode:resolve')
  @Get('v1/floor/scan')
  scan(@Query('code') code: string, @CurrentUser() p: AuthPrincipal) {
    return this.codes.resolve(code, p);
  }

  /* ── queue and jobs ─────────────────────────────────────────────────────────────────── */

  @Permissions('production:floor_queue:read')
  @Get('v1/floor/queue')
  list(@Query('stage') stage?: string) {
    return this.queue.queue(stage || null);
  }

  @Permissions('production:floor_queue:read')
  @Get('v1/floor/find')
  find(@Query('ref') ref: string) {
    return this.stations.findJob(ref);
  }

  @Permissions('production:floor_job:write')
  @Get('v1/floor/job-candidates')
  candidates() { return this.stations.jobCandidates(); }

  @Permissions('production:floor_job:write')
  @Post('v1/floor/jobs')
  create(@Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    const id = s(b?.productionOrderId);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('Choose a production order.');
    const steps = Array.isArray(b?.steps) ? (b.steps as unknown[]).map(s) : [];
    return this.stations.createJob(id, { promiseDt: b?.promiseDt ? s(b.promiseDt) : null, expedite: b?.expedite === true, steps,
      channel: b?.channel ? s(b.channel) : null, customerTier: b?.customerTier ? s(b.customerTier) : null,
      coverSuggestionId: /^[0-9a-f-]{36}$/i.test(s(b?.coverSuggestionId)) ? s(b.coverSuggestionId) : null }, p);
  }

  @Permissions('production:floor_pick:write')
  @Get('v1/floor/jobs/:id/pick')
  pickView(@Param('id', ParseUUIDPipe) id: string) {
    return this.stations.pickView(id);
  }

  @Permissions('production:floor_pick:write')
  @Post('v1/floor/jobs/:id/pick/lines/:line')
  pickLine(@Param('id', ParseUUIDPipe) id: string, @Param('line', ParseUUIDPipe) line: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.stations.pickLine(id, line, { bin: s(b?.bin), barcode: s(b?.barcode), reason: s(b?.reason) }, p);
  }

  @Permissions('production:floor_pick:write')
  @Post('v1/floor/jobs/:id/pick/complete')
  completePick(@Param('id', ParseUUIDPipe) id: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.stations.completePick(id, { tote: s(b?.tote) }, p);
  }

  @Permissions('production:floor_verify:write')
  @Get('v1/floor/jobs/:id/verify')
  verifyView(@Param('id', ParseUUIDPipe) id: string) {
    return this.stations.verifyView(id);
  }

  @Permissions('production:floor_verify:write')
  @Post('v1/floor/jobs/:id/verify/lines/:line')
  verifyLine(@Param('id', ParseUUIDPipe) id: string, @Param('line', ParseUUIDPipe) line: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.stations.verifyLine(id, line, { actualMg: b?.actualMg, source: s(b?.source), scaleRef: b?.scaleRef ? s(b.scaleRef) : undefined }, p);
  }

  @Permissions('production:floor_verify:write')
  @Post('v1/floor/jobs/:id/verify/complete')
  completeVerify(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() p: AuthPrincipal) {
    return this.stations.completeVerify(id, p);
  }

  @Permissions('production:floor_mix:write')
  @Get('v1/floor/jobs/:id/mix')
  mixView(@Param('id', ParseUUIDPipe) id: string) {
    return this.stations.mixView(id);
  }

  @Permissions('production:floor_mix:write')
  @Post('v1/floor/jobs/:id/mix/steps/:seq')
  step(@Param('id', ParseUUIDPipe) id: string, @Param('seq', ParseIntPipe) seq: number, @CurrentUser() p: AuthPrincipal) {
    return this.stations.doStep(id, seq, p);
  }

  @Permissions('production:floor_mix:write')
  @Post('v1/floor/jobs/:id/mix/complete')
  completeMix(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() p: AuthPrincipal) {
    return this.stations.completeMix(id, p);
  }

  @Permissions('production:floor_label:write')
  @Post('v1/floor/jobs/:id/labels')
  print(@Param('id', ParseUUIDPipe) id: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.stations.print(id, s(b?.kind).toUpperCase() as LabelKind, b?.reason ? s(b.reason) : null, p);
  }
}
