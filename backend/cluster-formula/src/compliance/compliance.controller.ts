/**
 * ComplianceController — the Vault console's compliance screens (owner ruling 2026-09-28, item 2).
 * Mounted ONLY on the Vault box (FormulaModule, VAULT_MODE=true). Every permission is `vault:*` —
 * never implicit for super_admin (PermissionsGuard's NEVER_IMPLICIT_PATTERNS), excluded from the
 * owner's blanket grant, and held by formulator / vault_approver only (scripts/ra-roles.ts):
 *
 *   vault:rm_compliance:read    raw-material compliance data, settings, allergen list, calc status
 *   vault:rm_compliance:write   edit / CSV-import that data and the settings, request a recalculation
 *   vault:compliance_calc:read  the calculation preview and the missing-data report — both decrypt
 *                               formulas and name ingredients, so a fresh sign-in is also required
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, FreshAuth, Permissions, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { ComplianceService } from './compliance.service.js';
import { IFRA_RESTRICTION_TYPES } from './compliance-calc.js';

const settingsBody = z.object({
  reportingThresholdPct: z.number().min(0).max(100).optional(),
  ifraAmendment: z.string().max(20).nullable().optional(),
  allergenListRef: z.string().max(60).nullable().optional(),
});

const materialDataBody = z.object({
  allergenComplete: z.boolean(),
  ifraComplete: z.boolean(),
  ifraAmendment: z.string().max(20).nullable().optional(),
  sourceRef: z.string().max(500).nullable().optional(),
  allergens: z.array(z.object({
    cas: z.string().min(1).max(20),
    naturalPct: z.number().min(0).max(100),
    syntheticPct: z.number().min(0).max(100),
  })).max(200),
  ifra: z.array(z.object({
    category: z.string().min(1).max(4),
    restrictionType: z.enum(IFRA_RESTRICTION_TYPES),
    maxPct: z.number().min(0).max(100).nullable(),
    amendment: z.string().min(1).max(20),
  })).max(40),
});

const importBody = z.object({
  kind: z.enum(['allergen', 'ifra', 'allergen_ref']),
  csv: z.string().min(1).max(2_000_000),
  commit: z.boolean().default(false),
});

const recalcBody = z.object({ formulaId: z.string().uuid().optional() });

@Controller()
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Permissions('vault:rm_compliance:read')
  @Get('v1/compliance/settings')
  settings() {
    return this.compliance.settings();
  }

  @Permissions('vault:rm_compliance:write')
  @Put('v1/compliance/settings')
  updateSettings(@Body(new ZodValidationPipe(settingsBody)) body: z.infer<typeof settingsBody>, @CurrentUser() principal: AuthPrincipal) {
    return this.compliance.updateSettings(body, principal);
  }

  @Permissions('vault:rm_compliance:read')
  @Get('v1/compliance/allergen-refs')
  allergenRefs() {
    return this.compliance.allergenReferences();
  }

  @Permissions('vault:rm_compliance:read')
  @Get('v1/compliance/materials')
  materials() {
    return this.compliance.listMaterialProfiles();
  }

  @Permissions('vault:rm_compliance:read')
  @Get('v1/compliance/materials/:materialId')
  material(@Param('materialId', ParseUUIDPipe) materialId: string) {
    return this.compliance.materialData(materialId);
  }

  @Permissions('vault:rm_compliance:write')
  @Put('v1/compliance/materials/:materialId')
  saveMaterial(
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Body(new ZodValidationPipe(materialDataBody)) body: z.infer<typeof materialDataBody>,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.compliance.saveMaterialData(materialId, body, principal);
  }

  /** CSV import: `commit: false` previews every row with its errors; `commit: true` applies the
   *  file only when it has none. */
  @Permissions('vault:rm_compliance:write')
  @Post('v1/compliance/import')
  import(@Body(new ZodValidationPipe(importBody)) body: z.infer<typeof importBody>, @CurrentUser() principal: AuthPrincipal) {
    return this.compliance.importCsv(body.kind, body.csv, body.commit, principal);
  }

  @Permissions('vault:rm_compliance:read')
  @Get('v1/compliance/status')
  status() {
    return this.compliance.calcStatuses();
  }

  @Permissions('vault:rm_compliance:write')
  @Post('v1/compliance/recalculate')
  recalculate(@Body(new ZodValidationPipe(recalcBody)) body: z.infer<typeof recalcBody>, @CurrentUser() principal: AuthPrincipal) {
    return body.formulaId
      ? this.compliance.recalculateFormula(body.formulaId, 'manual', principal.userId).then((r) => [r])
      : this.compliance.recalculateAll('manual', principal.userId);
  }

  @Permissions('vault:compliance_calc:read')
  @FreshAuth()
  @Get('v1/compliance/preview/:formulaId')
  preview(@Param('formulaId', ParseUUIDPipe) formulaId: string, @CurrentUser() principal: AuthPrincipal) {
    return this.compliance.preview(formulaId, principal);
  }

  @Permissions('vault:compliance_calc:read')
  @FreshAuth()
  @Get('v1/compliance/missing')
  missing(@CurrentUser() principal: AuthPrincipal) {
    return this.compliance.missingDataReport(principal);
  }
}
