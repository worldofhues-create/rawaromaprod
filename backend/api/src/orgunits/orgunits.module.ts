/** OrgUnitsModule — Organization Management (M01). Shared PG_CLIENT. */
import { Module } from '@nestjs/common';
import { OrgUnitsController } from './orgunits.controller.js';
import { OrgUnitsService } from './orgunits.service.js';

@Module({
  controllers: [OrgUnitsController],
  providers: [OrgUnitsService],
})
export class OrgUnitsModule {}
