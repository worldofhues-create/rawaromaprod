/**
 * RequirementController — REST over the requirement + purchase-request tables, plus the
 * PR flow endpoints (submit/approve). Reads require `procurement:<table>:read`, writes and
 * flow transitions `:write`. Per-arg ZodValidationPipe; principal from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { RequirementService } from './requirement.service.js';
import {
  approvePurchaseRequest,
  createPurchaseRequest,
  createPurchaseRequestApproval,
  createPurchaseRequestItem,
  createStockReqItem,
  createStockRequirement,
  listQuery,
  submitPurchaseRequest,
  type ApprovePurchaseRequest,
  type CreatePurchaseRequest,
  type CreatePurchaseRequestApproval,
  type CreatePurchaseRequestItem,
  type CreateStockReqItem,
  type CreateStockRequirement,
  type ListQuery,
  type SubmitPurchaseRequest,
} from '../cluster-procurement.dtos.js';

@Controller()
export class RequirementController {
  constructor(private readonly requirements: RequirementService) {}

  /* ── stock_requirement ──────────────────────────────────────────────── */

  @Permissions('procurement:stock_requirement:read')
  @Get('v1/stock-requirements')
  listStockRequirements(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.requirements.listStockRequirements(query);
  }

  @Permissions('procurement:stock_requirement:read')
  @Get('v1/stock-requirements/:id')
  getStockRequirement(@Param('id') id: string) {
    return this.requirements.getStockRequirement(id);
  }

  @Permissions('procurement:stock_requirement:write')
  @Post('v1/stock-requirements')
  createStockRequirement(
    @Body(new ZodValidationPipe(createStockRequirement)) body: CreateStockRequirement,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.requirements.createStockRequirement(body, principal);
  }

  /* ── stock_req_items ────────────────────────────────────────────────── */

  @Permissions('procurement:stock_req_items:read')
  @Get('v1/stock-req-items')
  listStockReqItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.requirements.listStockReqItems(query);
  }

  @Permissions('procurement:stock_req_items:read')
  @Get('v1/stock-req-items/:id')
  getStockReqItem(@Param('id') id: string) {
    return this.requirements.getStockReqItem(id);
  }

  @Permissions('procurement:stock_req_items:write')
  @Post('v1/stock-req-items')
  createStockReqItem(
    @Body(new ZodValidationPipe(createStockReqItem)) body: CreateStockReqItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.requirements.createStockReqItem(body, principal);
  }

  /* ── purchase_request ───────────────────────────────────────────────── */

  @Permissions('procurement:purchase_request:read')
  @Get('v1/purchase-requests')
  listPurchaseRequests(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.requirements.listPurchaseRequests(query);
  }

  @Permissions('procurement:purchase_request:read')
  @Get('v1/purchase-requests/:id')
  getPurchaseRequest(@Param('id') id: string) {
    return this.requirements.getPurchaseRequest(id);
  }

  @Permissions('procurement:purchase_request:write')
  @Post('v1/purchase-requests')
  createPurchaseRequest(
    @Body(new ZodValidationPipe(createPurchaseRequest)) body: CreatePurchaseRequest,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.requirements.createPurchaseRequest(body, principal);
  }

  @Permissions('procurement:purchase_request:write')
  @Post('v1/purchase-requests/:id/submit')
  submitPurchaseRequest(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitPurchaseRequest)) body: SubmitPurchaseRequest,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.requirements.submitPurchaseRequest(id, body, principal);
  }

  @Permissions('procurement:purchase_request:write')
  @Post('v1/purchase-requests/:id/approve')
  approvePurchaseRequest(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approvePurchaseRequest)) body: ApprovePurchaseRequest,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.requirements.approvePurchaseRequest(id, body, principal);
  }

  /* ── purchase_request_items ─────────────────────────────────────────── */

  @Permissions('procurement:purchase_request_items:read')
  @Get('v1/purchase-request-items')
  listPurchaseRequestItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.requirements.listPurchaseRequestItems(query);
  }

  @Permissions('procurement:purchase_request_items:read')
  @Get('v1/purchase-request-items/:id')
  getPurchaseRequestItem(@Param('id') id: string) {
    return this.requirements.getPurchaseRequestItem(id);
  }

  @Permissions('procurement:purchase_request_items:write')
  @Post('v1/purchase-request-items')
  createPurchaseRequestItem(
    @Body(new ZodValidationPipe(createPurchaseRequestItem))
    body: CreatePurchaseRequestItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.requirements.createPurchaseRequestItem(body, principal);
  }

  /* ── purchase_request_approval ──────────────────────────────────────── */

  @Permissions('procurement:purchase_request_approval:read')
  @Get('v1/purchase-request-approvals')
  listPurchaseRequestApprovals(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.requirements.listPurchaseRequestApprovals(query);
  }

  @Permissions('procurement:purchase_request_approval:read')
  @Get('v1/purchase-request-approvals/:id')
  getPurchaseRequestApproval(@Param('id') id: string) {
    return this.requirements.getPurchaseRequestApproval(id);
  }

  @Permissions('procurement:purchase_request_approval:write')
  @Post('v1/purchase-request-approvals')
  createPurchaseRequestApproval(
    @Body(new ZodValidationPipe(createPurchaseRequestApproval))
    body: CreatePurchaseRequestApproval,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.requirements.createPurchaseRequestApproval(body, principal);
  }
}
