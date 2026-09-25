/** PackagingQcModule — Module 9 packaging QC + the FG label step (OPS-GREEN Act L). Uses the shared PG_CLIENT (global from the kernel). */
import { Module } from '@nestjs/common';
import { PackagingQcController } from './packaging-qc.controller.js';
import { PackagingQcService } from './packaging-qc.service.js';
import { FgLabelService } from './fg-label.service.js';

@Module({
  controllers: [PackagingQcController],
  providers: [PackagingQcService, FgLabelService],
})
export class PackagingQcModule {}
