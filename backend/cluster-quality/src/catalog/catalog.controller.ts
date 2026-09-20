/**
 * CatalogController — REST over the QC parameter catalog. Reads require
 * `quality:qc_parameter_master:read`, writes `:write`. Per-arg ZodValidationPipe; principal
 * from the token on writes.
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
  createQcParameter,
  listQuery,
  type CreateQcParameter,
  type ListQuery,
} from '../quality.dtos.js';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Permissions('quality:qc_parameter_master:read')
  @Get('v1/qc-parameters')
  listQcParameters(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.catalog.listQcParameters(query);
  }

  @Permissions('quality:qc_parameter_master:read')
  @Get('v1/qc-parameters/:id')
  getQcParameter(@Param('id') id: string) {
    return this.catalog.getQcParameter(id);
  }

  @Permissions('quality:qc_parameter_master:write')
  @Post('v1/qc-parameters')
  createQcParameter(
    @Body(new ZodValidationPipe(createQcParameter)) body: CreateQcParameter,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.catalog.createQcParameter(body, principal);
  }
}
