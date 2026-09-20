/**
 * FgStockController — read-only finished-goods available-to-promise. Gated by the existing
 * FG-batch read permission (packaging + sales + owner hold it), so no new permission seed.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Permissions } from '@core/backend-kernel';
import { FgStockService } from './fg-stock.service.js';

@Controller()
export class FgStockController {
  constructor(private readonly svc: FgStockService) {}

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/fg-stock')
  availability(
    @Query('limit') limit?: string,
    @Query('productSkuId') productSkuId?: string,
    @Query('onlyAvailable') onlyAvailable?: string,
  ) {
    return this.svc.availability({
      limit: limit ? Number(limit) : 100,
      productSkuId,
      onlyAvailable: onlyAvailable === '1' || onlyAvailable === 'true',
    });
  }

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/fg-stock/by-sku')
  bySku(@Query('limit') limit?: string) {
    return this.svc.bySku({ limit: limit ? Number(limit) : 100 });
  }
}
