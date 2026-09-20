/** AuditModule — owner/admin governance reads (formula-access audit, login history). Shared PG_CLIENT. */
import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

@Module({
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}
