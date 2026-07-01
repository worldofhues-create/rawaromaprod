/**
 * InventoryViewController — read-only inventory availability + FEFO. Gated by the existing
 * inventory batch read permission (warehouse + owner hold it), so no new permission seed.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Permissions } from '@core/backend-kernel';
import { InventoryViewService } from './inventory-view.service.js';

@Controller()
export class InventoryViewController {
  constructor(private readonly svc: InventoryViewService) {}

  @Permissions('inventory:inventory_batch:read')
  @Get('v1/inventory-availability')
  availability(@Query('limit') limit?: string, @Query('materialId') materialId?: string) {
    return this.svc.availability({ limit: limit ? Number(limit) : 100, materialId });
  }
}
