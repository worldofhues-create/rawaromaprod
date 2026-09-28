/**
 * PackagingQcController — REST over packaging QC. Gated by the packaging cluster's existing
 * finished-good permissions (the packaging role + owner hold them), so no new permission seed.
 */
import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { PackagingQcService } from './packaging-qc.service.js';
import { FgLabelService } from './fg-label.service.js';
import { ProductDgService } from './product-dg.service.js';

@Controller()
export class PackagingQcController {
  constructor(
    private readonly svc: PackagingQcService,
    private readonly labels: FgLabelService,
    private readonly dg: ProductDgService,
  ) {}

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/packaging-qc')
  list(@Query('limit') limit?: string) {
    return this.svc.list(limit ? Number(limit) : 100);
  }

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/packaging-qc/:id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Permissions('packaging:finished_good_batch_master:write')
  @Post('v1/packaging-qc')
  create(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.create(body, principal);
  }

  /* OPS-GREEN Act L: the LABEL step (fg-label.service.ts). Same finished-good permissions as QC. */
  @Permissions('packaging:finished_good_batch_master:write')
  @Post('v1/finished-good-batches/:id/labels')
  applyLabel(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.labels.apply(id, body, principal);
  }

  /* Lane produce: the label as it prints now (QC-gated exactly like applying one). */
  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/finished-good-batches/:id/label')
  previewLabel(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.labels.preview(id, principal);
  }

  /* Lane produce: a product's DG/hazard block, printed on its labels where set. */
  @Permissions('packaging:product_master:read')
  @Get('v1/products/:id/dg-info')
  dgInfo(@Param('id') id: string) {
    return this.dg.get(id);
  }

  @Permissions('packaging:product_master:write')
  @Put('v1/products/:id/dg-info')
  setDgInfo(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.dg.set(id, body, principal);
  }

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/fg-labels')
  listLabels(@Query('finishedGoodBatchId') finishedGoodBatchId?: string, @Query('limit') limit?: string) {
    return this.labels.list(finishedGoodBatchId, limit ? Number(limit) : 100);
  }
}
