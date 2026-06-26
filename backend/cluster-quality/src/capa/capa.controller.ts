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
import { createQcCapa, listQuery, type CreateQcCapa, type ListQuery } from '../quality.dtos.js';

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
}
