/** RelayModule — offline air-gap store-and-forward (export/import/status). Uses shared PG_CLIENT. */
import { Module } from '@nestjs/common';
import { RelayController } from './relay.controller.js';
import { RelayService } from './relay.service.js';

@Module({
  controllers: [RelayController],
  providers: [RelayService],
})
export class RelayModule {}
