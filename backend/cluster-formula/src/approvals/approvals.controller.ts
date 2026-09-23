/**
 * ApprovalsController — REST over version approval + the copy-request workflow. Approving a
 * version (`formula:formula_approval:write`) locks the recipe and emits the production signal;
 * copy requests are created and decided under `formula:formula_copy_request:*`.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  FreshAuth,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { ApprovalsService } from './approvals.service.js';
import {
  approveVersion,
  createCopyRequest,
  decideCopyRequest,
  listQuery,
  lockVersion,
  rejectVersion,
  submitForReview,
  type ApproveVersion,
  type CreateCopyRequest,
  type DecideCopyRequest,
  type ListQuery,
  type LockVersion,
  type RejectVersion,
  type SubmitForReview,
} from '../formula.dtos.js';

@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /* ── version approval ─────────────────────────────────────────────── */

  @Permissions('formula:formula_approval:read')
  @Get('v1/formula-approvals')
  listApprovals(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.approvals.listApprovals(query);
  }

  // §109.8 DRAFT|VERSIONED → REVIEW. Author-side, same permission as drafting — no SoD (see
  // ApprovalsService.submitForReview doc comment).
  @Permissions('formula:formula_version:write')
  @Post('v1/formula-versions/:id/submit-for-review')
  submitForReview(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitForReview)) body: SubmitForReview,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.approvals.submitForReview(id, body, principal);
  }

  // §108 SoD (the version's author may not approve it) is enforced server-side in the
  // service regardless of caller/role — this decorator pair is the edge-layer half:
  // vault_approver-only permission (never implicit, per permissions.guard.ts) + a
  // recently-issued token (§109.5).
  @Permissions('formula:formula_approval:write')
  @FreshAuth()
  @Post('v1/formula-versions/:id/approve')
  approveVersion(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approveVersion)) body: ApproveVersion,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.approvals.approveVersion(id, body, principal);
  }

  @Permissions('formula:formula_approval:write')
  @FreshAuth()
  @Post('v1/formula-versions/:id/reject')
  rejectVersion(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectVersion)) body: RejectVersion,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.approvals.rejectVersion(id, body, principal);
  }

  // §109.8 APPROVED → LOCKED. Same vault-authority gate as approve/reject.
  @Permissions('formula:formula_approval:write')
  @FreshAuth()
  @Post('v1/formula-versions/:id/lock')
  lockVersion(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(lockVersion)) body: LockVersion,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.approvals.lockVersion(id, body, principal);
  }

  /* ── copy requests ────────────────────────────────────────────────── */

  @Permissions('formula:formula_copy_request:read')
  @Get('v1/formula-copy-requests')
  listCopyRequests(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.approvals.listCopyRequests(query);
  }

  @Permissions('formula:formula_copy_request:write')
  @Post('v1/formula-copy-requests')
  createCopyRequest(
    @Body(new ZodValidationPipe(createCopyRequest)) body: CreateCopyRequest,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.approvals.createCopyRequest(body, principal);
  }

  @Permissions('formula:formula_copy_request:write')
  @Post('v1/formula-copy-requests/:id/decide')
  decideCopyRequest(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideCopyRequest)) body: DecideCopyRequest,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.approvals.decideCopyRequest(id, body, principal);
  }
}
