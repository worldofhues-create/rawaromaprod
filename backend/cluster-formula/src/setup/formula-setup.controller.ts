/**
 * FormulaSetupController — the Vault box's formula-setup routes (lane vaultsetup). Mounted only
 * with VAULT_MODE=true (formula.module.ts), like every other formula route.
 *
 *   POST /v1/formula-shells                 draft one shell per product        formula_master/version/ingredients:write
 *   GET  /v1/formula-setup/recipes          every shell and its state          formula:formula_version:read
 *   POST /v1/formula-recipes/import         recipe CSV preview / seal          formula:formula_ingredients:write
 *   GET  /v1/formula-review-queue           versions waiting for a decision    formula:formula_approval:read
 *   POST /v1/formula-versions/approve-batch approve many, one fresh sign-in    formula:formula_approval:write + @FreshAuth
 *
 * The shell route demands all three drafting permissions (a formulator holds them; the Ruh
 * service principal holds them once two owners have granted it `formulator`). The batch approval
 * keeps @FreshAuth's semantics exactly: the guard runs once for the request, against the caller's
 * own credential time, before any version is touched — one step-up covers one batch, never a
 * window the client can stretch.
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, FreshAuth, Permissions, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { ComplianceService } from '../compliance/compliance.service.js';
import {
  approveBatchBody,
  formulaShellsBody,
  recipeImportBody,
  type ApproveBatchBody,
  type FormulaShellsBody,
  type RecipeImportBody,
} from '../formula.dtos.js';
import { FormulaSetupService } from './formula-setup.service.js';

@Controller()
export class FormulaSetupController {
  constructor(
    private readonly setup: FormulaSetupService,
    private readonly compliance: ComplianceService,
  ) {}

  @Permissions('formula:formula_master:write', 'formula:formula_version:write', 'formula:formula_ingredients:write')
  @Post('v1/formula-shells')
  shells(@Body(new ZodValidationPipe(formulaShellsBody)) body: FormulaShellsBody, @CurrentUser() principal: AuthPrincipal) {
    return this.setup.ensureShells(body, principal);
  }

  @Permissions('formula:formula_version:read')
  @Get('v1/formula-setup/recipes')
  recipes() {
    return this.setup.recipes();
  }

  @Permissions('formula:formula_ingredients:write')
  @Post('v1/formula-recipes/import')
  importRecipes(@Body(new ZodValidationPipe(recipeImportBody)) body: RecipeImportBody, @CurrentUser() principal: AuthPrincipal) {
    return this.setup.importRecipes(body, principal);
  }

  @Permissions('formula:formula_approval:read')
  @Get('v1/formula-review-queue')
  reviewQueue(@CurrentUser() principal: AuthPrincipal) {
    return this.setup.reviewQueue(principal);
  }

  @Permissions('formula:formula_approval:write')
  @FreshAuth()
  @Post('v1/formula-versions/approve-batch')
  async approveBatch(@Body(new ZodValidationPipe(approveBatchBody)) body: ApproveBatchBody, @CurrentUser() principal: AuthPrincipal) {
    const results = await this.setup.approveMany(body.versionIds, body.remarks, principal);
    // Same as the single approve route: each newly approved formula's certificates are
    // recalculated off the request path (a calculation failure never fails an approval).
    for (const r of results) {
      if (r.approved && r.formulaId) this.compliance.recalculateFormulaInBackground(r.formulaId, 'version_approved', principal.userId);
    }
    return { results, approved: results.filter((r) => r.approved).length, refused: results.filter((r) => !r.approved).length };
  }
}
