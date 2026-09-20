/** EditModule — cross-cutting master edit / deactivate. Uses the shared PG_CLIENT (global). */
import { Module } from '@nestjs/common';
import { EditController } from './edit.controller.js';
import { EditService } from './edit.service.js';

@Module({
  controllers: [EditController],
  providers: [EditService],
})
export class EditModule {}
