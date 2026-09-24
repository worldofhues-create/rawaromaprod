/**
 * TutorialModule — wires TutorialController/Service. `PG_CLIENT` comes from the globally
 * registered kernel module (same as PlatformOpsModule — see that file's own comment).
 */
import { Module } from '@nestjs/common';
import { TutorialController } from './tutorial.controller.js';
import { TutorialService } from './tutorial.service.js';

@Module({
  controllers: [TutorialController],
  providers: [TutorialService],
})
export class TutorialModule {}
