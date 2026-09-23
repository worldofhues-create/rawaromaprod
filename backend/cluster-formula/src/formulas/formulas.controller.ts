/**
 * FormulasController — REST over the formula document, its versions, the seal flow, and the
 * owner-only actual-recipe read. Reads require `formula:<table>:read`, writes `:write`. The
 * decrypted recipe at `/actual` is gated by the dedicated, owner-only `formula:actual:read`
 * permission — distinct from the structural reads so the recipe can never leak through a
 * broad read grant. Per-arg ZodValidationPipe; principal from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  FreshAuth,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { FormulasService } from './formulas.service.js';
import {
  actualReadQuery,
  addIngredients,
  addStageIngredients,
  createFormula,
  createStage,
  createVersion,
  listQuery,
  searchMaterialsQuery,
  type ActualReadQuery,
  type AddIngredients,
  type AddStageIngredients,
  type CreateFormula,
  type CreateStage,
  type CreateVersion,
  type ListQuery,
  type SearchMaterialsQuery,
} from '../formula.dtos.js';

@Controller()
export class FormulasController {
  constructor(private readonly formulas: FormulasService) {}

  /* ── formula master ───────────────────────────────────────────────── */

  @Permissions('formula:formula_master:read')
  @Get('v1/formulas')
  listFormulas(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.formulas.listFormulas(query);
  }

  @Permissions('formula:formula_master:read')
  @Get('v1/formulas/:id')
  getFormula(@Param('id') id: string) {
    return this.formulas.getFormula(id);
  }

  @Permissions('formula:formula_master:write')
  @Post('v1/formulas')
  createFormula(
    @Body(new ZodValidationPipe(createFormula)) body: CreateFormula,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.formulas.createFormula(body, principal);
  }

  // Verify the tamper-evidence of the vault access-audit chain (owner-only). Recomputes the
  // KEK-keyed hash chain and reports {ok, rows, firstBadSeq}.
  @Permissions('formula:actual:read')
  @Get('v1/formula-audit-verify')
  verifyAuditChain() {
    return this.formulas.verifyAuditChain();
  }

  // The Vault draft editor's material picker — `vault.*` permission (not the ordinary
  // masterdata:material:* read/reveal), minimal fields (id/code/name), so sealing an
  // ingredient no longer means typing a raw material UUID by hand.
  @Permissions('vault:material_search:read')
  @Get('v1/vault/materials')
  searchMaterials(@Query(new ZodValidationPipe(searchMaterialsQuery)) query: SearchMaterialsQuery) {
    return this.formulas.searchMaterials(query.q, query.limit);
  }

  /* ── formula version ──────────────────────────────────────────────── */

  @Permissions('formula:formula_version:read')
  @Get('v1/formula-versions')
  listVersions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.formulas.listVersions(query);
  }

  @Permissions('formula:formula_version:read')
  @Get('v1/formula-versions/:id')
  getVersion(@Param('id') id: string) {
    return this.formulas.getVersion(id);
  }

  @Permissions('formula:formula_version:write')
  @Post('v1/formula-versions')
  createVersion(
    @Body(new ZodValidationPipe(createVersion)) body: CreateVersion,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.formulas.createVersion(body, principal);
  }

  /* ── seal flow: version ingredients ──────────────────────────────── */

  @Permissions('formula:formula_ingredients:write')
  @Post('v1/formula-versions/:id/ingredients')
  addIngredients(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addIngredients)) body: AddIngredients,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.formulas.addIngredients(id, body, principal);
  }

  @Permissions('formula:formula_ingredients:read')
  @Get('v1/formula-versions/:id/ingredients')
  listIngredients(@Param('id') id: string) {
    return this.formulas.listIngredients(id);
  }

  // §109.8 DRAFT → VERSIONED. Same authority as sealing ingredients (formulator side, no SoD).
  @Permissions('formula:formula_version:write')
  @Post('v1/formula-versions/:id/finalize')
  finalizeVersion(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.formulas.finalizeVersion(id, principal);
  }

  /* ── Vault-role-only decrypted recipe (§107/§109) ─────────────────── */

  // `formula:actual:read` never short-circuits via super_admin (permissions.guard.ts) — only
  // formulator/vault_approver hold it (scripts/ra-roles.ts). §109.5 fresh-auth + §109.6/§109.8
  // access-reason apply: the caller must have re-authenticated within the window AND supply a
  // reason, both required before this ever reaches VaultService.decryptVersion.
  @Permissions('formula:actual:read')
  @FreshAuth()
  @Get('v1/formula-versions/:id/actual')
  getActualFormula(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(actualReadQuery)) query: ActualReadQuery,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.formulas.getActualFormula(id, query.reason, principal);
  }

  /* ── stages + sealed stage ingredients ───────────────────────────── */

  @Permissions('formula:formula_stage_master:write')
  @Post('v1/formula-stages')
  createStage(
    @Body(new ZodValidationPipe(createStage)) body: CreateStage,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.formulas.createStage(body, principal);
  }

  @Permissions('formula:formula_stage_master:read')
  @Get('v1/formula-versions/:id/stages')
  listStages(@Param('id') id: string) {
    return this.formulas.listStages(id);
  }

  @Permissions('formula:formula_stage_ingredients:write')
  @Post('v1/formula-stages/:id/ingredients')
  addStageIngredients(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addStageIngredients)) body: AddStageIngredients,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.formulas.addStageIngredients(id, body, principal);
  }
}
