/**
 * FactorySetupController (FACTORY-SETUP, lane catalogue) — the factory setup checklist, Ruh's
 * proposals and the one-person approval, plus the signed endpoint ALEMBIC sends its catalogue to.
 *
 *   POST v1/bridge/catalogue/sync               PUBLIC — the HMAC over timestamp.nonce.body IS the
 *                                               credential (as v1/bridge/facts/query)
 *   GET  v1/factory-setup/checklist             any of: QC spec read, rack read, production read
 *   GET  v1/factory-setup/catalogue             formula:formula_version:read — the Vault console's
 *                                               formula work reads classification + material ids here
 *   GET  v1/factory-setup/qc-proposals          production:product_qc_spec:read
 *   POST v1/factory-setup/qc-proposals/draft    production:product_qc_spec:write (qc, owner)
 *   POST v1/factory-setup/qc-proposals/decide   production:product_qc_spec:write (qc, owner)
 *   GET  v1/factory-setup/rack-proposals        location:rack_master:read
 *   POST v1/factory-setup/rack-proposals/draft  rack + shelf + bin write (warehouse, owner)
 *   POST v1/factory-setup/rack-proposals/:id/decide  rack + shelf + bin write (warehouse, owner)
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser, DynamicPermission, Permissions, Public, type AuthPrincipal } from '@core/backend-kernel';
import { FactoryCatalogueService } from './catalogue.service.js';
import { FactorySetupService } from './setup.service.js';
import { SetupStatusService } from './setup-status.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHECKLIST_PERMISSIONS = ['production:product_qc_spec:read', 'location:rack_master:read', 'production:production_order:read'];

function decisionOf(body: Record<string, unknown> | undefined): { decision: 'approve' | 'reject'; note: string | null } {
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject') throw new BadRequestException("'decision' is 'approve' or 'reject'.");
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  return { decision, note };
}

@Controller()
export class FactorySetupController {
  constructor(
    private readonly catalogueSync: FactoryCatalogueService,
    private readonly setup: FactorySetupService,
    private readonly status: SetupStatusService,
  ) {}

  /* NO @HttpCode: the status is the outcome (200, 400 malformed, 401 unsigned/replayed, 403 wrong tenant). */
  @Public()
  @Post('v1/bridge/catalogue/sync')
  async sync(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('x-bridge-signature') signature: string | undefined,
    @Headers('x-bridge-timestamp') timestamp: string | undefined,
    @Headers('x-bridge-nonce') nonce: string | undefined,
  ) {
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const result = await this.catalogueSync.handle(rawBody, signature ?? null, timestamp ?? null, nonce ?? null);
    reply.status(result.status);
    return result.body;
  }

  @DynamicPermission('the checklist is counts only; it opens for anyone who holds the QC spec, rack or production read permission, checked in the handler')
  @Get('v1/factory-setup/checklist')
  checklist(@CurrentUser() principal: AuthPrincipal) {
    if (!CHECKLIST_PERMISSIONS.some((p) => principal.permissions.includes(p)) && !principal.roles.includes('owner')) {
      throw new ForbiddenException('The factory setup checklist is for QC, warehouse, production and the owner.');
    }
    return this.status.counts();
  }

  @Permissions('formula:formula_version:read')
  @Get('v1/factory-setup/catalogue')
  catalogue(@Query('limit') limit?: string) {
    return this.setup.catalogue(limit ? Number(limit) : undefined);
  }

  @Permissions('production:product_qc_spec:read')
  @Get('v1/factory-setup/qc-proposals')
  qcProposals(@Query('status') status?: string) {
    return this.setup.listProposals('qc_spec', status ?? 'proposed');
  }

  @Permissions('production:product_qc_spec:write')
  @Post('v1/factory-setup/qc-proposals/draft')
  draftQc(@Body() body: { limit?: unknown } | undefined, @CurrentUser() principal: AuthPrincipal) {
    const limit = typeof body?.limit === 'number' ? body.limit : undefined;
    return this.setup.draftQc(principal, limit);
  }

  @Permissions('production:product_qc_spec:write')
  @Post('v1/factory-setup/qc-proposals/decide')
  decideQc(@Body() body: Record<string, unknown> | undefined, @CurrentUser() principal: AuthPrincipal) {
    const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).filter((x): x is string => typeof x === 'string' && UUID.test(x)) : [];
    if (ids.length === 0 || ids.length > 500) throw new BadRequestException("Name the drafts to decide ('ids', 1 to 500).");
    const { decision, note } = decisionOf(body);
    return this.setup.decideQc(ids, decision, note, principal);
  }

  @Permissions('location:rack_master:read')
  @Get('v1/factory-setup/rack-proposals')
  rackProposals(@Query('status') status?: string) {
    return this.setup.listProposals('rack_layout', status ?? 'proposed');
  }

  @Permissions('location:rack_master:write', 'location:shelf_master:write', 'location:bin_master:write')
  @Post('v1/factory-setup/rack-proposals/draft')
  draftRacks(@CurrentUser() principal: AuthPrincipal) {
    return this.setup.draftRacks(principal);
  }

  @Permissions('location:rack_master:write', 'location:shelf_master:write', 'location:bin_master:write')
  @Post('v1/factory-setup/rack-proposals/:id/decide')
  decideRacks(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: Record<string, unknown> | undefined,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    const { decision, note } = decisionOf(body);
    return this.setup.decideRacks(id, decision, body?.layout, note, principal);
  }
}
