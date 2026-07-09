/** FgStockModule — finished-goods available-to-promise read-model. Uses the shared PG_CLIENT (global). */
import { Module } from '@nestjs/common';
import { FgStockController } from './fg-stock.controller.js';
import { FgStockService } from './fg-stock.service.js';

@Module({
  controllers: [FgStockController],
  providers: [FgStockService],
})
export class FgStockModule {}
