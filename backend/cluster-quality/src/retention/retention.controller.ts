/**
 * RetentionController — REST over QC_SAMPLE_RETENTION. Reads require
 * `quality:qc_sample_retention:read`, writes `:write`. Per-arg ZodValidationPipe; principal
 * from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { RetentionService } from './retention.service.js';
import {
  createQcSampleRetention,
  listQuery,
  type CreateQcSampleRetention,
  type ListQuery,
} from '../quality.dtos.js';

@Controller()
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Permissions('quality:qc_sample_retention:read')
  @Get('v1/qc-sample-retentions')
  listSampleRetentions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.retention.listSampleRetentions(query);
  }

  @Permissions('quality:qc_sample_retention:read')
  @Get('v1/qc-sample-retentions/:id')
  getSampleRetention(@Param('id') id: string) {
    return this.retention.getSampleRetention(id);
  }

  @Permissions('quality:qc_sample_retention:write')
  @Post('v1/qc-sample-retentions')
  createSampleRetention(
    @Body(new ZodValidationPipe(createQcSampleRetention)) body: CreateQcSampleRetention,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.retention.createSampleRetention(body, principal);
  }
}
