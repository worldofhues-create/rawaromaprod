/**
 * IMPORT-RP — the factory's bulk-import routes. One set of routes serves every kind, so the kind is
 * part of the address and the permission cannot be a static decorator: each handler goes through
 * ImportEngine.handler(), which refuses a caller who does not hold THAT kind's own permission
 * (kind-specs.ts `permission`) before anything is read or written.
 *
 *   GET  /v1/imports/kinds                the kinds this person may run, with their columns
 *   GET  /v1/imports/history?kind=        every import of those kinds: who, when, the counts
 *   GET  /v1/imports/:kind/template       the template (?format=xlsx|csv), as { fileName, mime, base64 }
 *   POST /v1/imports/:kind/preview        { fileName, fileBase64 }: judged, nothing written but the job
 *   GET  /v1/imports/jobs/:id             a job and its rows (the uploader only)
 *   POST /v1/imports/jobs/:id/commit      { fileBase64, mode }: the same file again; refused if it changed
 *   POST /v1/imports/jobs/:id/problems    { format }: the refused rows with a Problem column
 *
 * Files travel as base64 inside JSON because the consoles' encrypted channel (/rpc) carries JSON only.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, DynamicPermission, type AuthPrincipal } from '@core/backend-kernel';
import { ImportsService, contextOf, fileBytes } from './imports.service.js';

const WHY = 'the import kind is in the address: ImportEngine.handler() checks that kind\'s own permission (api/src/imports/kind-specs.ts) and throws 403 before any read or write';
const s = (v: unknown) => (typeof v === 'string' ? v : '');

@Controller()
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @DynamicPermission(WHY)
  @Get('v1/imports/kinds')
  kinds(@CurrentUser() p: AuthPrincipal) {
    return { items: this.imports.engine.kindsFor(p), nextCursor: null };
  }

  @DynamicPermission(WHY)
  @Get('v1/imports/history')
  async history(@Query('kind') kind: string | undefined, @CurrentUser() p: AuthPrincipal) {
    return { items: await this.imports.history(p, kind || undefined), nextCursor: null };
  }

  @DynamicPermission(WHY)
  @Get('v1/imports/jobs/:id')
  job(@Param('id') id: string, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.job(id, p);
  }

  @DynamicPermission(WHY)
  @Post('v1/imports/jobs/:id/commit')
  commit(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.commit(id, { bytes: fileBytes(body?.fileBase64), mode: body?.mode }, contextOf(p));
  }

  @DynamicPermission(WHY)
  @Post('v1/imports/jobs/:id/problems')
  problems(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.problems(id, { format: s(body?.format) }, contextOf(p));
  }

  @DynamicPermission(WHY)
  @Get('v1/imports/:kind/template')
  template(@Param('kind') kind: string, @Query('format') format: string | undefined, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.template(kind, s(format), p);
  }

  @DynamicPermission(WHY)
  @Post('v1/imports/:kind/preview')
  preview(@Param('kind') kind: string, @Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.imports.engine.preview(kind, { bytes: fileBytes(body?.fileBase64), fileName: s(body?.fileName) }, contextOf(p));
  }
}
