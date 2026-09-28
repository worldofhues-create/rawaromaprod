/**
 * CoaController — the factory QC screens behind the Certificate of Analysis (owner ruling
 * 2026-09-28, item 1): the per-product QC spec, the per-batch results/photos, and the release that
 * emits `qc.batch.released` to ALEMBIC. Specs and results are QC work (`qc` role); release has its
 * own permission so it can be granted separately from data entry.
 */
import { Body, Controller, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Permissions, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { CoaService } from './coa.service.js';
import {
  listCoaQuery,
  recordBatchCoa,
  rejectBatchCoa,
  type RejectBatchCoa,
  upsertProductQcSpec,
  type ListCoaQuery,
  type RecordBatchCoa,
  type UpsertProductQcSpec,
} from './coa.dtos.js';

@Controller()
export class CoaController {
  constructor(private readonly coa: CoaService) {}

  @Permissions('production:product_qc_spec:read')
  @Get('v1/product-qc-specs')
  listSpecs() {
    return this.coa.listSpecs();
  }

  @Permissions('production:product_qc_spec:read')
  @Get('v1/product-qc-specs/:productId')
  async getSpec(@Param('productId') productId: string) {
    const spec = await this.coa.getSpec(productId);
    if (!spec) throw new NotFoundException(`no QC spec for product ${productId}`);
    return spec;
  }

  @Permissions('production:product_qc_spec:write')
  @Put('v1/product-qc-specs/:productId')
  upsertSpec(
    @Param('productId') productId: string,
    @Body(new ZodValidationPipe(upsertProductQcSpec)) body: UpsertProductQcSpec,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.coa.upsertSpec(productId, body, principal);
  }

  @Permissions('production:batch_coa:read')
  @Get('v1/batch-coas')
  list(@Query(new ZodValidationPipe(listCoaQuery)) query: ListCoaQuery) {
    return this.coa.listCoas(query);
  }

  @Permissions('production:batch_coa:read')
  @Get('v1/batch-coas/:id')
  async get(@Param('id') id: string) {
    const coa = await this.coa.getCoa(id);
    if (!coa) throw new NotFoundException(`batch COA not found: ${id}`);
    return coa;
  }

  /** The products this oil batch's formula maps to — the batch screen's product picker. */
  @Permissions('production:batch_coa:read')
  @Get('v1/oil-batches/:id/coa-products')
  candidateProducts(@Param('id') id: string) {
    return this.coa.productsForBatch(id);
  }

  @Permissions('production:batch_coa:write')
  @Post('v1/batch-coas')
  record(@Body(new ZodValidationPipe(recordBatchCoa)) body: RecordBatchCoa, @CurrentUser() principal: AuthPrincipal) {
    return this.coa.recordCoa(body, principal);
  }

  @Permissions('production:batch_coa:release')
  @Post('v1/batch-coas/:id/release')
  release(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.coa.releaseCoa(id, principal);
  }

  /** Lane produce: QC's FAIL verdict. Same permission as release — both are the QC decision. */
  @Permissions('production:batch_coa:release')
  @Post('v1/batch-coas/:id/reject')
  reject(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectBatchCoa)) body: RejectBatchCoa,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.coa.rejectCoa(id, body.reason, principal);
  }
}
