/**
 * AuditController — owner/admin governance reads. Formula-access audit is owner-gated (it reveals
 * who touched the IP); login history is admin-gated. Both are read-only.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Permissions } from '@core/backend-kernel';
import { AuditService } from './audit.service.js';

@Controller()
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Permissions('formula:actual:read')
  @Get('v1/formula-access-audit')
  formulaAccess(@Query('limit') limit?: string) {
    return this.svc.formulaAccessAudit(limit ? Number(limit) : 100);
  }

  @Permissions('iam:user_master:read')
  @Get('v1/login-history')
  loginHistory(@Query('limit') limit?: string) {
    return this.svc.loginHistory(limit ? Number(limit) : 100);
  }
}
