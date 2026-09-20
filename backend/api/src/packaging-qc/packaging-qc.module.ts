/** PackagingQcModule — Module 9 packaging QC. Uses the shared PG_CLIENT (global from the kernel). */
import { Module } from '@nestjs/common';
import { PackagingQcController } from './packaging-qc.controller.js';
import { PackagingQcService } from './packaging-qc.service.js';

@Module({
  controllers: [PackagingQcController],
  providers: [PackagingQcService],
})
export class PackagingQcModule {}
