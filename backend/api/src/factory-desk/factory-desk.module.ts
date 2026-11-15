/** RP-BE-1 — the RAC OS Factory console's missing reads and writes (factory-desk.controller.ts). */
import { Module } from '@nestjs/common';
import { FactoryDeskController } from './factory-desk.controller.js';
import { FactoryDeskService } from './factory-desk.service.js';
import { FactoryDeskWritesService } from './factory-desk-writes.service.js';

@Module({
  controllers: [FactoryDeskController],
  providers: [FactoryDeskService, FactoryDeskWritesService],
})
export class FactoryDeskModule {}
