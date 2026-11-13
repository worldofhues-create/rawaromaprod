/**
 * PROD-A-4..6 — the floor's routes (production-floor plan §3, §5, §6, §12.2). Each station write is
 * its own permission (picker / verifier / mixer); the services re-check stage, order and
 * separation of duties on every call, so a person holding two floor roles still cannot verify
 * their own pick.
 */
import { BadRequestException, Body, Controller, Get, Header, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { FloorCodeService } from './floor-code.service.js';
import { FloorStationService, type LabelKind } from './floor-station.service.js';
import { FloorQueueService } from './floor-queue.service.js';
import { LotSplitService } from './lot-split.service.js';
import { MaterialImportService } from './material-import.service.js';

const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

@Controller()
export class FloorController {
  constructor(
    private readonly codes: FloorCodeService,
    private readonly stations: FloorStationService,
    private readonly queue: FloorQueueService,
    private readonly splits: LotSplitService,
    private readonly materialImport: MaterialImportService,
  ) {}

  /* ── colour table and floor codes ───────────────────────────────────────────────────── */

  /** STOCK-FIX-RP (STK-17): raw materials from a CSV, a dry run unless commit is true. */
  @Permissions('masterdata:material_import:write')
  @Post('v1/materials/import')
  importMaterials(@Body() body: { csv?: unknown; commit?: unknown }, @CurrentUser() p: AuthPrincipal) {
    return this.materialImport.import(body, p);
  }

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

  /* ── FLOOR-1 (R8): split a lot across two bins; the child's label; the genealogy ─────── */

  @Permissions('inventory:lot_split:write')
  @Post('v1/floor/lots/:code/split')
  split(@Param('code') code: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.splits.split(code, { qtyMg: b?.qtyMg, bin: b?.bin, reason: b?.reason }, p);
  }

  @Permissions('inventory:lot_split:write')
  @Post('v1/floor/lots/:code/label')
  splitLabel(@Param('code') code: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.splits.printLabel(code, b?.reason ? s(b.reason) : null, p);
  }

  @Permissions('inventory:lot_barcode:resolve')
  @Get('v1/floor/lots/:code/genealogy')
  genealogy(@Param('code') code: string) {
    return this.splits.genealogy(code);
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
    return this.stations.verifyLine(id, line, { actualMg: b?.actualMg, source: b?.source === undefined ? undefined : s(b.source), scaleRef: b?.scaleRef ? s(b.scaleRef) : undefined, weightCheckId: b?.weightCheckId ? s(b.weightCheckId) : undefined }, p);
  }

  // FLOOR-LOT-STOP-1: the supervisor's permission (the one that answers for a held reading) resumes a
  // stopped line. The service refuses the person whose scan stopped it.
  @Permissions('production:floor_job:write')
  @Post('v1/floor/jobs/:id/stop/resume')
  resumeLine(@Param('id', ParseUUIDPipe) id: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.stations.clearStop(id, { reason: b?.reason }, p);
  }

  // STOCK2-1: the permission that puts a job on the floor is the one that answers for a held reading.
  @Permissions('production:floor_job:write')
  @Post('v1/floor/lines/:line/over-pick')
  approveOverPick(@Param('line', ParseUUIDPipe) line: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.stations.approveOverPick(line, { reason: b?.reason }, p);
  }

  @Permissions('production:floor_verify:write')
  @Post('v1/floor/jobs/:id/verify/complete')
  completeVerify(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() p: AuthPrincipal) {
    return this.stations.completeVerify(id, p);
  }

  // FLOOR-1 (R8): the verifier's leftover goes back to stock as a child lot tied to this job.
  @Permissions('production:floor_verify:write')
  @Get('v1/floor/jobs/:id/leftover')
  leftovers(@Param('id', ParseUUIDPipe) id: string) {
    return this.splits.jobReturns(id);
  }

  @Permissions('production:floor_verify:write')
  @Post('v1/floor/jobs/:id/leftover')
  leftover(@Param('id', ParseUUIDPipe) id: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.splits.returnLeftover(id, { lot: b?.lot, qtyMg: b?.qtyMg, bin: b?.bin }, p);
  }

  // LEFTOVER-AFTER-FINISH: Scan a lot asks what can still come back; the write stays the route above.
  @Permissions('production:floor_verify:write')
  @Get('v1/floor/lots/:code/leftover')
  leftoverOptions(@Param('code') code: string, @CurrentUser() p: AuthPrincipal) {
    return this.splits.leftoverOptions(code, p);
  }

  @Permissions('production:floor_verify:write')
  @Post('v1/floor/jobs/:id/leftover/label')
  leftoverLabel(@Param('id', ParseUUIDPipe) id: string, @Body() b: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.splits.printJobLabel(id, b?.lot, b?.reason ? s(b.reason) : null, p);
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

  /** STOCK-FIX-RP (STK-15, D-1): assign the batch to one mixer, by name (a supervisor). */
  @Permissions('production:floor_job:write')
  @Post('v1/floor/jobs/:id/mix/assign')
  assignMixer(@Param('id', ParseUUIDPipe) id: string, @Body() body: { userId?: string }, @CurrentUser() p: AuthPrincipal) {
    return this.stations.assignMixer(id, String(body?.userId ?? ''), p);
  }

  /** STOCK-FIX-RP (STK-15, D-1): the current step's material name, to the assigned mixer only.
   *  Never cached: the name is for the screen in front of the mixer, for this step. */
  @Permissions('production:floor_mix:reveal_name')
  @Header('Cache-Control', 'no-store')
  @Post('v1/floor/jobs/:id/mix/reveal')
  revealCurrentStep(@Param('id', ParseUUIDPipe) id: string, @Body() body: { seq?: unknown }, @CurrentUser() p: AuthPrincipal) {
    if (body?.seq !== undefined && !(typeof body.seq === 'number' && Number.isInteger(body.seq))) throw new BadRequestException('seq is a step number.');
    return this.stations.revealCurrentStep(id, { seq: body?.seq as number | undefined }, p);
  }

  /** STOCK-FIX-RP (STK-15): who saw a name on this job, at which step, when. Ids and times only. */
  @Permissions('production:floor_job:write')
  @Get('v1/floor/jobs/:id/mix/reveals')
  revealLog(@Param('id', ParseUUIDPipe) id: string) {
    return this.stations.revealLog(id);
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
