/** InventoryViewModule — Module 6 availability/FEFO read. Uses the shared PG_CLIENT (global). */
import { Module } from '@nestjs/common';
import { InventoryViewController } from './inventory-view.controller.js';
import { InventoryViewService } from './inventory-view.service.js';

@Module({
  controllers: [InventoryViewController],
  providers: [InventoryViewService],
})
export class InventoryViewModule {}
