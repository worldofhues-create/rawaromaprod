/**
 * CapaController — REST over QC_CAPA (table-only CRUD). Reads require `quality:qc_capa:read`,
 * writes `:write`. Per-arg ZodValidationPipe; principal from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { CapaService } from './capa.service.js';
import {
  closeCapa,
  createQcCapa,
  listQuery,
  verifyCapa,
  type CloseCapa,
  type CreateQcCapa,
  type ListQuery,
  type VerifyCapa,
} from '../quality.dtos.js';

@Controller()
export class CapaController {
  constructor(private readonly capa: CapaService) {}

  @Permissions('quality:qc_capa:read')
  @Get('v1/qc-capas')
  listCapas(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.capa.listCapas(query);
  }

  @Permissions('quality:qc_capa:read')
  @Get('v1/qc-capas/:id')
  getCapa(@Param('id') id: string) {
    return this.capa.getCapa(id);
  }

  @Permissions('quality:qc_capa:write')
  @Post('v1/qc-capas')
  createCapa(
    @Body(new ZodValidationPipe(createQcCapa)) body: CreateQcCapa,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.capa.createCapa(body, principal);
  }

  /* ── flow: closure + verification workflow ────────────────────────── */

  @Permissions('quality:qc_capa:write')
  @Post('v1/qc-capas/:id/start')
  startCapa(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.capa.startCapa(id, principal);
  }

  @Permissions('quality:qc_capa:write')
  @Post('v1/qc-capas/:id/close')
  closeCapa(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(closeCapa)) body: CloseCapa,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.capa.closeCapa(id, body, principal);
  }

  @Permissions('quality:qc_capa:write')
  @Post('v1/qc-capas/:id/verify')
  verifyCapa(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(verifyCapa)) body: VerifyCapa,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.capa.verifyCapa(id, body, principal);
  }
}
