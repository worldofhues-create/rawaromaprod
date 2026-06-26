/**
 * BatchController — REST over the RM-batch genealogy tables, plus the batch-release flow
 * (POST /v1/rm-batches/:id/release). Reads require `inventory:<table>:read`, writes `:write`.
 * Per-arg ZodValidationPipe; principal from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { BatchService } from './batch.service.js';
import {
  createBatchContainerMapping,
  createBatchGenealogyHistory,
  createRmBatch,
  listQuery,
  releaseRmBatch,
  type CreateBatchContainerMapping,
  type CreateBatchGenealogyHistory,
  type CreateRmBatch,
  type ListQuery,
  type ReleaseRmBatch,
} from '../cluster-inventory.dtos.js';

@Controller()
export class BatchController {
  constructor(private readonly batches: BatchService) {}

  /* ── rm_batch_master ────────────────────────────────────────────────── */

  @Permissions('inventory:rm_batch_master:read')
  @Get('v1/rm-batches')
  listRmBatches(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batches.listRmBatches(query);
  }

  @Permissions('inventory:rm_batch_master:read')
  @Get('v1/rm-batches/:id')
  getRmBatch(@Param('id') id: string) {
    return this.batches.getRmBatch(id);
  }

  @Permissions('inventory:rm_batch_master:write')
  @Post('v1/rm-batches')
  createRmBatch(
    @Body(new ZodValidationPipe(createRmBatch)) body: CreateRmBatch,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batches.createRmBatch(body, principal);
  }

  @Permissions('inventory:rm_batch_master:write')
  @Post('v1/rm-batches/:id/release')
  releaseRmBatch(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(releaseRmBatch)) body: ReleaseRmBatch,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batches.releaseRmBatch(id, body, principal);
  }

  /* ── batch_container_mappings ───────────────────────────────────────── */

  @Permissions('inventory:batch_container_mappings:read')
  @Get('v1/batch-container-mappings')
  listBatchContainerMappings(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batches.listBatchContainerMappings(query);
  }

  @Permissions('inventory:batch_container_mappings:read')
  @Get('v1/batch-container-mappings/:id')
  getBatchContainerMapping(@Param('id') id: string) {
    return this.batches.getBatchContainerMapping(id);
  }

  @Permissions('inventory:batch_container_mappings:write')
  @Post('v1/batch-container-mappings')
  createBatchContainerMapping(
    @Body(new ZodValidationPipe(createBatchContainerMapping))
    body: CreateBatchContainerMapping,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batches.createBatchContainerMapping(body, principal);
  }

  /* ── batch_genealogy_history ────────────────────────────────────────── */

  @Permissions('inventory:batch_genealogy_history:read')
  @Get('v1/batch-genealogy-histories')
  listBatchGenealogyHistories(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batches.listBatchGenealogyHistories(query);
  }

  @Permissions('inventory:batch_genealogy_history:read')
  @Get('v1/batch-genealogy-histories/:id')
  getBatchGenealogyHistory(@Param('id') id: string) {
    return this.batches.getBatchGenealogyHistory(id);
  }

  @Permissions('inventory:batch_genealogy_history:write')
  @Post('v1/batch-genealogy-histories')
  createBatchGenealogyHistory(
    @Body(new ZodValidationPipe(createBatchGenealogyHistory))
    body: CreateBatchGenealogyHistory,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batches.createBatchGenealogyHistory(body, principal);
  }
}
