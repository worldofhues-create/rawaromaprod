/** PROD-D-5 — the QC review decision routes (plan 12.7.4). Reading needs production:qc_review:read;
 *  proposing and confirming need a signature permission (perfumer or approver), which the service
 *  checks against the person's own permissions; defining downgrade targets and reblend rules needs
 *  production:qc_review_setup:write. */
import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { QcReviewService } from './qc-review.service.js';

type B = Record<string, unknown>;

@Controller()
export class QcReviewController {
  constructor(private readonly review: QcReviewService) {}

  @Permissions('production:qc_review:read')
  @Get('v1/qc-review')
  list() { return this.review.list(); }

  @Permissions('production:qc_review:read')
  @Get('v1/qc-review/:id')
  detail(@Param('id') id: string) { return this.review.detail(id); }

  @Permissions('production:qc_review:read')
  @Post('v1/qc-review/:id/propose')
  propose(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.review.propose(id, b ?? {}, p); }

  @Permissions('production:qc_review:read')
  @Post('v1/qc-review/:id/confirm')
  confirm(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.review.confirm(id, b ?? {}, p); }

  @Permissions('production:qc_review:read')
  @Post('v1/qc-review/:id/withdraw')
  withdraw(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.review.withdraw(id, b ?? {}, p); }

  @Permissions('production:qc_review_setup:write')
  @Put('v1/qc-review/downgrade-targets/:productId')
  downgrade(@Param('productId') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.review.setDowngradeTarget(id, b ?? {}, p); }

  @Permissions('production:qc_review_setup:write')
  @Put('v1/qc-review/reblend-rules/:formulaId')
  reblend(@Param('formulaId') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.review.setReblendRule(id, b ?? {}, p); }
}
