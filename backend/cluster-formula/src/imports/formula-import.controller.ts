/**
 * IMPORT-RP — the Vault box's import routes, mounted only with VAULT_MODE=true (formula.module.ts),
 * like every other formula route. Every one demands `vault:formula_import:write` (the formulator),
 * statically: there is one kind here, so nothing is left to a check inside the handler.
 *
 *   GET  /v1/imports/kinds                the formulas kind and its columns
 *   GET  /v1/imports/history              who uploaded, when, the counts. Never a line of a recipe
 *   GET  /v1/imports/:kind/template       the empty template
 *   POST /v1/imports/:kind/preview        { fileName, fileBase64 }: judged; the job keeps no cell
 *   GET  /v1/imports/jobs/:id             the uploader's own job: row numbers, outcomes, problems
 *   POST /v1/imports/jobs/:id/commit      { fileBase64, mode }: sealed through the recipe import
 *   POST /v1/imports/jobs/:id/problems    { format, fileBase64 }: the rows to fix, read from the file
 *                                         the person sends again, returned to them and kept nowhere
 *
 * THE ANSWER TO `problems` IS THE ONE ANSWER HERE THAT HOLDS RECIPE LINES (the person's own refused
 * rows). The Vault's idempotency interceptor stores a write's answer so a re-sent request is not run
 * twice; @NoStoredReply() keeps this one out of that store. Every other answer on this controller
 * names row numbers, formula codes, version numbers and fixed phrases only.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, NoStoredReply, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { FormulaImportService, contextOf, fileBytes } from './formula-import.service.js';

const PERMISSION = 'vault:formula_import:write';
const s = (v: unknown) => (typeof v === 'string' ? v : '');

@Controller()
export class FormulaImportController {
  constructor(private readonly imports: FormulaImportService) {}

  @Permissions(PERMISSION)
  @Get('v1/imports/kinds')
  kinds(@CurrentUser() p: AuthPrincipal) {
    return { items: this.imports.engine.kindsFor(p), nextCursor: null };
  }

  @Permissions(PERMISSION)
  @Get('v1/imports/history')
  async history(@Query('kind') kind: string | undefined, @CurrentUser() p: AuthPrincipal) {
    return { items: await this.imports.engine.history(p, kind || undefined), nextCursor: null };
  }

  @Permissions(PERMISSION)
  @Get('v1/imports/jobs/:id')
  job(@Param('id') id: string, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.job(id, p);
  }

  @Permissions(PERMISSION)
  @Post('v1/imports/jobs/:id/commit')
  commit(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.commit(id, { bytes: fileBytes(body?.fileBase64), mode: body?.mode }, contextOf(p));
  }

  @Permissions(PERMISSION)
  @NoStoredReply()
  @Post('v1/imports/jobs/:id/problems')
  problems(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.problems(id, { format: s(body?.format), bytes: fileBytes(body?.fileBase64) }, contextOf(p));
  }

  @Permissions(PERMISSION)
  @Get('v1/imports/:kind/template')
  template(@Param('kind') kind: string, @Query('format') format: string | undefined, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.template(kind, s(format), p);
  }

  @Permissions(PERMISSION)
  @Post('v1/imports/:kind/preview')
  preview(@Param('kind') kind: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.preview(kind, { bytes: fileBytes(body?.fileBase64), fileName: s(body?.fileName) }, contextOf(p));
  }
}
