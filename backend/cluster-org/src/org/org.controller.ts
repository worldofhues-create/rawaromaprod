/**
 * OrgController — REST CRUD over the organization tables. Masters are permission-gated
 * (`iam:<table>:read` / `:write`). List + getById are reads; create is a write that
 * stamps the current principal.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { listQuery, type ListQuery } from '../cluster-org.dtos.js';
import { OrgService } from './org.service.js';
import {
  createBusinessUnitBody,
  createOrgBody,
  createOrgGroupBody,
  createOrgRelationshipBody,
  createOrgTypeBody,
  type CreateBusinessUnitBody,
  type CreateOrgBody,
  type CreateOrgGroupBody,
  type CreateOrgRelationshipBody,
  type CreateOrgTypeBody,
} from './org.dtos.js';

@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  // ── org_group_master ──────────────────────────────────────────────────────
  @Permissions('iam:org_group_master:read')
  @Get('v1/org-groups')
  listOrgGroups(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.org.listOrgGroups(query);
  }

  @Permissions('iam:org_group_master:read')
  @Get('v1/org-groups/:id')
  getOrgGroup(@Param('id') id: string) {
    return this.org.getOrgGroupById(id);
  }

  @Permissions('iam:org_group_master:write')
  @Post('v1/org-groups')
  createOrgGroup(
    @Body(new ZodValidationPipe(createOrgGroupBody)) body: CreateOrgGroupBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.org.createOrgGroup(body, principal);
  }

  // ── org_type_master ───────────────────────────────────────────────────────
  @Permissions('iam:org_type_master:read')
  @Get('v1/org-types')
  listOrgTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.org.listOrgTypes(query);
  }

  @Permissions('iam:org_type_master:read')
  @Get('v1/org-types/:id')
  getOrgType(@Param('id') id: string) {
    return this.org.getOrgTypeById(id);
  }

  @Permissions('iam:org_type_master:write')
  @Post('v1/org-types')
  createOrgType(
    @Body(new ZodValidationPipe(createOrgTypeBody)) body: CreateOrgTypeBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.org.createOrgType(body, principal);
  }

  // ── org_master ────────────────────────────────────────────────────────────
  @Permissions('iam:org_master:read')
  @Get('v1/orgs')
  listOrgs(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.org.listOrgs(query);
  }

  @Permissions('iam:org_master:read')
  @Get('v1/orgs/:id')
  getOrg(@Param('id') id: string) {
    return this.org.getOrgById(id);
  }

  @Permissions('iam:org_master:write')
  @Post('v1/orgs')
  createOrg(
    @Body(new ZodValidationPipe(createOrgBody)) body: CreateOrgBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.org.createOrg(body, principal);
  }

  // ── org_relationship ──────────────────────────────────────────────────────
  @Permissions('iam:org_relationship:read')
  @Get('v1/org-relationships')
  listOrgRelationships(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.org.listOrgRelationships(query);
  }

  @Permissions('iam:org_relationship:read')
  @Get('v1/org-relationships/:id')
  getOrgRelationship(@Param('id') id: string) {
    return this.org.getOrgRelationshipById(id);
  }

  @Permissions('iam:org_relationship:write')
  @Post('v1/org-relationships')
  createOrgRelationship(
    @Body(new ZodValidationPipe(createOrgRelationshipBody))
    body: CreateOrgRelationshipBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.org.createOrgRelationship(body, principal);
  }

  // ── business_unit_master ──────────────────────────────────────────────────
  @Permissions('iam:business_unit_master:read')
  @Get('v1/business-units')
  listBusinessUnits(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.org.listBusinessUnits(query);
  }

  @Permissions('iam:business_unit_master:read')
  @Get('v1/business-units/:id')
  getBusinessUnit(@Param('id') id: string) {
    return this.org.getBusinessUnitById(id);
  }

  @Permissions('iam:business_unit_master:write')
  @Post('v1/business-units')
  createBusinessUnit(
    @Body(new ZodValidationPipe(createBusinessUnitBody)) body: CreateBusinessUnitBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.org.createBusinessUnit(body, principal);
  }
}
