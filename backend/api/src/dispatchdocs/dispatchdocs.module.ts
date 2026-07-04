/** DispatchDocsModule — dispatch document chain. Shared PG_CLIENT. */
import { Module } from '@nestjs/common';
import { DispatchDocsController } from './dispatchdocs.controller.js';
import { DispatchDocsService } from './dispatchdocs.service.js';

@Module({
  controllers: [DispatchDocsController],
  providers: [DispatchDocsService],
})
export class DispatchDocsModule {}
