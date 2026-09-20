/**
 * PickingController — REST over the picking masters + the generate-pick-list / issue-materials
 * flows. Reads require `production:<table>:read`, writes `:write`. Pick lists are generated from
 * an order's ingredients (`/v1/production-orders/:id/pick-list`); issues are recorded against
 * the order (`/v1/material-issues`) and emit the cross-cluster signal. Per-arg ZodValidationPipe.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { PickingService } from './picking.service.js';
import {
  createIssue,
  generatePickList,
  listQuery,
  type CreateIssue,
  type GeneratePickList,
  type ListQuery,
} from '../production.dtos.js';

@Controller()
export class PickingController {
  constructor(private readonly picking: PickingService) {}

  /* ── material pick list ───────────────────────────────────────────── */

  @Permissions('production:material_pick_list:read')
  @Get('v1/material-pick-lists')
  listPickLists(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.picking.listPickLists(query);
  }

  @Permissions('production:material_pick_list:read')
  @Get('v1/material-pick-lists/:id')
  getPickList(@Param('id') id: string) {
    return this.picking.getPickList(id);
  }

  @Permissions('production:material_pick_list_items:read')
  @Get('v1/material-pick-list-items')
  listPickListItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.picking.listPickListItems(query);
  }

  @Permissions('production:material_pick_list_items:read')
  @Get('v1/material-pick-list-items/:id')
  getPickListItem(@Param('id') id: string) {
    return this.picking.getPickListItem(id);
  }

  /* ── flow: generate pick list ────────────────────────────────────── */

  @Permissions('production:material_pick_list:write')
  @Post('v1/production-orders/:id/pick-list')
  generatePickList(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(generatePickList)) body: GeneratePickList,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.picking.generatePickList(id, body, principal);
  }

  /* ── material issue ───────────────────────────────────────────────── */

  @Permissions('production:material_issue:read')
  @Get('v1/material-issues')
  listIssues(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.picking.listIssues(query);
  }

  @Permissions('production:material_issue:read')
  @Get('v1/material-issues/:id')
  getIssue(@Param('id') id: string) {
    return this.picking.getIssue(id);
  }

  @Permissions('production:material_issue_item:read')
  @Get('v1/material-issue-items')
  listIssueItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.picking.listIssueItems(query);
  }

  @Permissions('production:material_issue_item:read')
  @Get('v1/material-issue-items/:id')
  getIssueItem(@Param('id') id: string) {
    return this.picking.getIssueItem(id);
  }

  /* ── flow: issue materials ───────────────────────────────────────── */

  @Permissions('production:material_issue:write')
  @Post('v1/material-issues')
  issueMaterials(
    @Body(new ZodValidationPipe(createIssue)) body: CreateIssue,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.picking.issueMaterials(body, principal);
  }
}
