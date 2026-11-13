/**
 * ImportsModule (IMPORT-RP) — the factory's bulk import: templates, preview, commit, the rows-to-fix
 * sheet and the history, for ingredients, suppliers, supplier lots, dilutions, opening raw stock, raw
 * stock adjustments and packaging materials. Each row is written by the single-record service.
 */
import { Module } from '@nestjs/common';
import { FloorModule } from '../floor/floor.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';
import { PurchasePriceController } from './purchase-price.controller.js';
import { PurchasePriceService } from './purchase-price.service.js';

@Module({
  imports: [FloorModule],
  controllers: [ImportsController, PurchasePriceController],
  providers: [ImportsService, PurchasePriceService],
})
export class ImportsModule {}
