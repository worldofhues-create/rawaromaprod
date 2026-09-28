/** PackagingQcModule — Module 9 packaging QC + the FG label step (OPS-GREEN Act L). Uses the shared PG_CLIENT (global from the kernel). */
import { Module } from '@nestjs/common';
import { PackagingQcController } from './packaging-qc.controller.js';
import { PackagingQcService } from './packaging-qc.service.js';
import { FgLabelService } from './fg-label.service.js';
import { ProductDgService } from './product-dg.service.js';
import { ShelfModule } from '../shelf/shelf.module.js';

@Module({
  imports: [ShelfModule],
  controllers: [PackagingQcController],
  providers: [PackagingQcService, FgLabelService, ProductDgService],
})
export class PackagingQcModule {}
