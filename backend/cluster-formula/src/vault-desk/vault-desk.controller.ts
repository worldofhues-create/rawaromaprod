/**
 * RP-BE-1 — the RAC OS Vault console's Overview and Version-draft reads (vault-desk.service.ts), and VF-FIX's
 * one formula's versions.
 * Vault box only. Metadata only (LD-261); each read is written to formula.audit_events first.
 */
import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { VaultDeskService } from './vault-desk.service.js';

type Req = { requestId?: string | null; ip?: string | null };

@Controller()
export class VaultDeskController {
  constructor(private readonly desk: VaultDeskService) {}

  @Permissions('formula:formula_version:read')
  @Get('v1/vault/overview')
  overview(@CurrentUser() p: AuthPrincipal, @Req() req: Req) {
    return this.desk.overview(p, { requestId: req?.requestId ?? null, ip: req?.ip ?? null });
  }

  @Permissions('formula:formula_version:write')
  @Get('v1/vault/version-draft')
  versionDraft(@CurrentUser() p: AuthPrincipal, @Query('base') base: string | undefined, @Req() req: Req) {
    return this.desk.versionDraft(p, base, { requestId: req?.requestId ?? null, ip: req?.ip ?? null });
  }

  // VF-FIX: the formula drawer's Versions tab. The formula's own read permission (as GET /v1/formulas/:id).
  @Permissions('formula:formula_master:read')
  @Get('v1/formulas/:id/versions')
  formulaVersions(@CurrentUser() p: AuthPrincipal, @Param('id') id: string, @Req() req: Req) {
    return this.desk.formulaVersions(p, id, { requestId: req?.requestId ?? null, ip: req?.ip ?? null });
  }
}
