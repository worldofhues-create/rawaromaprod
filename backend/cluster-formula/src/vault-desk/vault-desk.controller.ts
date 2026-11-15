/**
 * RP-BE-1 — the RAC OS Vault console's Overview and Version-draft reads (vault-desk.service.ts).
 * Vault box only. Metadata only (LD-261); each read is written to formula.audit_events first.
 */
import { Controller, Get, Query, Req } from '@nestjs/common';
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
}
