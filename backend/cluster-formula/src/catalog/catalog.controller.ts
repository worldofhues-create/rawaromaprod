/**
 * CatalogController — REST over the non-secret formula masters + the read-only logs. Reads
 * require `formula:<table>:read`, writes `:write`. No endpoint here exposes ciphertext or
 * decrypted recipe — those live only on the formulas controller's audited `/actual` read.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { CatalogService } from './catalog.service.js';
import {
  createAccessPolicy,
  createDocumentMapping,
  createFormulaType,
  listQuery,
  type CreateAccessPolicy,
  type CreateDocumentMapping,
  type CreateFormulaType,
  type ListQuery,
} from '../formula.dtos.js';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /* ── formula type master ──────────────────────────────────────────── */

  @Permissions('formula:formula_type_master:read')
  @Get('v1/formula-types')
  listTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listTypes(query);
  }

  @Permissions('formula:formula_type_master:read')
  @Get('v1/formula-types/:id')
  getType(@Param('id') id: string) {
    return this.catalog.getType(id);
  }

  @Permissions('formula:formula_type_master:write')
  @Post('v1/formula-types')
  createType(
    @Body(new ZodValidationPipe(createFormulaType)) body: CreateFormulaType,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createType(body, principal);
  }

  /* ── access policy ────────────────────────────────────────────────── */

  @Permissions('formula:formula_access_policy:read')
  @Get('v1/formula-access-policies')
  listAccessPolicies(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listAccessPolicies(query);
  }

  @Permissions('formula:formula_access_policy:write')
  @Post('v1/formula-access-policies')
  createAccessPolicy(
    @Body(new ZodValidationPipe(createAccessPolicy)) body: CreateAccessPolicy,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createAccessPolicy(body, principal);
  }

  /* ── document mapping ─────────────────────────────────────────────── */

  @Permissions('formula:formula_document_mapping:read')
  @Get('v1/formula-document-mappings')
  listDocumentMappings(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listDocumentMappings(query);
  }

  @Permissions('formula:formula_document_mapping:write')
  @Post('v1/formula-document-mappings')
  createDocumentMapping(
    @Body(new ZodValidationPipe(createDocumentMapping)) body: CreateDocumentMapping,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createDocumentMapping(body, principal);
  }

  /* ── read-only logs ───────────────────────────────────────────────── */

  @Permissions('formula:formula_change_log:read')
  @Get('v1/formula-change-logs')
  listChangeLog(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listChangeLog(query);
  }

  @Permissions('formula:formula_event_hist:read')
  @Get('v1/formula-event-hist')
  listEventHist(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listEventHist(query);
  }
}
