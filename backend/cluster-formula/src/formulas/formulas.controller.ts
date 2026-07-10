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
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { FormulasService } from './formulas.service.js';
import {
  addIngredients,
  addStageIngredients,
  createFormula,
  createStage,
  createVersion,
  listQuery,
  type AddIngredients,
  type AddStageIngredients,
  type CreateFormula,
  type CreateStage,
  type CreateVersion,
  type ListQuery,
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

  /* ── owner-only decrypted recipe ─────────────────────────────────── */

  @Permissions('formula:actual:read')
  @Get('v1/formula-versions/:id/actual')
  getActualFormula(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.formulas.getActualFormula(id, principal);
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
