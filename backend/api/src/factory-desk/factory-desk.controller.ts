/**
 * RP-BE-1 — the RAC OS Factory console's reads and writes that RawProd had no route for, plus the
 * Vault console's floor-code reveal (VT-141), which is main-box data. One line per route in
 * docs/relay-contract-vault-factory.md (method, path, permission, step-up, idempotency, fields).
 *
 * Permissions are RawProd's own existing strings (no new permission, no grant changed). A route that
 * goes against the system's next step or opens what is masked is @FreshAuth (the session's proof no
 * older than five minutes; through the ALEMBIC relay that is the RAC OS step-up time).
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, FreshAuth, NoStoredReply, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { FactoryDeskService } from './factory-desk.service.js';
import { FactoryDeskWritesService } from './factory-desk-writes.service.js';

type Body = Record<string, unknown>;

@Controller()
export class FactoryDeskController {
  constructor(private readonly reads: FactoryDeskService, private readonly writes: FactoryDeskWritesService) {}

  /* ── reads ─────────────────────────────────────────────────────────────────────────────── */

  @Permissions('production:production_order:read')
  @Get('v1/factory/today')
  today() { return this.reads.today(); }

  @Permissions('production:floor_queue:read')
  @Get('v1/floor/board')
  board() { return this.reads.board(); }

  @Permissions('production:floor_queue:read')
  @Get('v1/floor/batches/:ref')
  /* LD-272: a relay token (`via: "relay"`) gets no quantity; see FactoryDeskService.batch. */
  batch(@Param('ref') ref: string, @CurrentUser() user?: AuthPrincipal) { return this.reads.batch(ref, { relay: user?.via === 'relay' }); }

  @Permissions('production:floor_queue:read')
  @Get('v1/floor/batches/:ref/route')
  batchRoute(@Param('ref') ref: string) { return this.reads.batchRoute(ref); }

  @Permissions('procurement:stock_requirement:read')
  @Get('v1/floor/stock-cover')
  stockCover(@Query('q') q?: string, @Query('state') state?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.reads.stockCover({ q, state, cursor, limit });
  }

  @Permissions('masterdata:floor_code:read')
  @Get('v1/floor/codes')
  floorCodes() { return this.reads.floorCodes(); }

  /* GET /v1/floor/codes/:materialId already exists (write permission, by material id), so one code by
   * its text is read at /summary rather than shadowing that route. */
  @Permissions('masterdata:floor_code:read')
  @Get('v1/floor/codes/:code/summary')
  codeSummary(@Param('code') code: string) { return this.reads.codeSummary(code); }

  @Permissions('masterdata:floor_code:read')
  @Get('v1/floor/codes/:code/lots')
  codeLots(@Param('code') code: string) { return this.reads.codeLots(code); }

  @Permissions('location:rack_master:read')
  @Get('v1/floor/racks')
  racks() { return this.reads.racks(); }

  @Permissions('quality:qc_inspections:read')
  @Get('v1/factory/qc-queue')
  qcQueue(@Query('kind') kind?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.reads.qcQueue({ kind, cursor, limit });
  }

  @Permissions('production:production_order:read')
  @Get('v1/trace/batches')
  traceBatches(@Query('q') q?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.reads.traceBatches({ q, cursor, limit });
  }

  @Permissions('inventory:rm_batch_master:read')
  @Get('v1/recalls')
  recalls(@Query('cursor') cursor?: string, @Query('limit') limit?: string) { return this.reads.recalls({ cursor, limit }); }

  @Permissions('platform:policy:read')
  @Get('v1/operating-rules')
  operatingRules(@Query('site') site?: string) { return this.reads.operatingRules(site); }

  @Permissions('production:maceration:read')
  @Get('v1/maceration/defaults')
  macerationDefaults(@Query('site') site?: string) { return this.reads.macerationDefaults(site); }

  @Permissions('iam:user_master:read')
  @Get('v1/role-change-requests/people')
  factoryPeople(@Query('q') q?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.reads.factoryPeople({ q, cursor, limit });
  }

  @Permissions('platform:device:read')
  @Get('v1/devices/:id/test')
  deviceTest(@Param('id', ParseUUIDPipe) id: string) { return this.reads.deviceTest(id); }

  /* ── writes (Idempotency-Key and the audit row come from the global interceptors) ────────── */

  @Permissions('procurement:purchase_order:write')
  @Post('v1/purchase-orders/:id/reject')
  rejectPo(@Param('id', ParseUUIDPipe) id: string, @Body() b: Body, @CurrentUser() p: AuthPrincipal) { return this.writes.rejectPo(id, b, p); }

  @Permissions('quality:qc_inspections:write')
  @FreshAuth()
  @Post('v1/prodfloor/qc/batches/:id/rounds/:round/decision')
  decideQc(@Param('id', ParseUUIDPipe) id: string, @Param('round') round: string, @Body() b: Body, @CurrentUser() p: AuthPrincipal) {
    return this.writes.decideQc(id, round, b, p);
  }

  @Permissions('inventory:rm_batch_master:write')
  @FreshAuth()
  @Post('v1/recalls')
  startRecall(@Body() b: Body, @CurrentUser() p: AuthPrincipal) { return this.writes.startRecall(b, p); }

  @Permissions('platform:print_job:write')
  @Post('v1/print-jobs/:id/cancel')
  cancelPrintJob(@Param('id', ParseUUIDPipe) id: string) { return this.writes.cancelPrintJob(id); }

  @Permissions('platform:device:write')
  @Post('v1/devices/:id/test')
  requestDeviceTest(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() p: AuthPrincipal) { return this.writes.requestDeviceTest(id, p); }

  @Permissions('platform:policy:write')
  @FreshAuth()
  @Post('v1/operating-rules')
  saveOperatingRules(@Body() b: Body, @CurrentUser() p: AuthPrincipal) { return this.writes.saveOperatingRules(b, p); }

  @Permissions('production:maceration_setting:write')
  @Put('v1/maceration/defaults')
  saveMacerationDefaults(@Query('site') site: string, @Body() b: Body, @CurrentUser() p: AuthPrincipal) {
    return this.writes.saveMacerationDefaults(site, b, p);
  }

  @Permissions('iam:user_master:read')
  @FreshAuth()
  @Post('v1/role-change-requests')
  requestRoleChange(@Body() b: Body, @CurrentUser() p: AuthPrincipal) { return this.writes.requestRoleChange(b, p); }

  @Permissions('production:floor_queue:read')
  @Post('v1/floor/problems')
  raiseProblem(@Body() b: Body, @CurrentUser() p: AuthPrincipal) { return this.writes.raiseProblem(b, p); }

  /* The answer carries a material's name: never kept in the idempotency store (a re-send runs again
   * and records a second reveal, which is the honest trail). */
  @Permissions('masterdata:material:reveal')
  @FreshAuth()
  @NoStoredReply()
  @Post('v1/floor/codes/:code/reveal')
  revealCode(@Param('code') code: string, @Body() b: Body, @CurrentUser() p: AuthPrincipal) { return this.writes.revealCode(code, b, p); }
}
