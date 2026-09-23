/**
 * SecurityController — REST CRUD over the user + RBAC tables. Permission-gated
 * (`iam:<table>:read` / `:write`). Login/auth lives in a separate cluster; user CREATE
 * here takes `passwordHash` directly for now.
 */
import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { listQuery, type ListQuery } from '../cluster-org.dtos.js';
import { SecurityService } from './security.service.js';
import {
  createLocationAuthorityBody,
  createPermissionBody,
  createRoleBody,
  createRolePermissionBody,
  createUserBody,
  createUserRoleBody,
  type CreateLocationAuthorityBody,
  type CreatePermissionBody,
  type CreateRoleBody,
  type CreateRolePermissionBody,
  type CreateUserBody,
  type CreateUserRoleBody,
} from './security.dtos.js';

@Controller()
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  // ── user_master ───────────────────────────────────────────────────────────
  @Permissions('iam:user_master:read')
  @Get('v1/users')
  listUsers(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.security.listUsers(query);
  }

  @Permissions('iam:user_master:read')
  @Get('v1/users/:id')
  getUser(@Param('id') id: string) {
    return this.security.getUserById(id);
  }

  @Permissions('iam:user_master:write')
  @Post('v1/users')
  createUser(
    @Body(new ZodValidationPipe(createUserBody)) body: CreateUserBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.security.createUser(body, principal);
  }

  // ── role_master ───────────────────────────────────────────────────────────
  @Permissions('iam:role_master:read')
  @Get('v1/roles')
  listRoles(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.security.listRoles(query);
  }

  @Permissions('iam:role_master:read')
  @Get('v1/roles/:id')
  getRole(@Param('id') id: string) {
    return this.security.getRoleById(id);
  }

  @Permissions('iam:role_master:write')
  @Post('v1/roles')
  createRole(
    @Body(new ZodValidationPipe(createRoleBody)) body: CreateRoleBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.security.createRole(body, principal);
  }

  // ── permission_master ─────────────────────────────────────────────────────
  @Permissions('iam:permission_master:read')
  @Get('v1/permissions')
  listPermissions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.security.listPermissions(query);
  }

  @Permissions('iam:permission_master:read')
  @Get('v1/permissions/:id')
  getPermission(@Param('id') id: string) {
    return this.security.getPermissionById(id);
  }

  @Permissions('iam:permission_master:write')
  @Post('v1/permissions')
  createPermission(
    @Body(new ZodValidationPipe(createPermissionBody)) body: CreatePermissionBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.security.createPermission(body, principal);
  }

  // ── role_permission_mapping ───────────────────────────────────────────────
  @Permissions('iam:role_permission_mapping:read')
  @Get('v1/role-permissions')
  listRolePermissions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.security.listRolePermissions(query);
  }

  @Permissions('iam:role_permission_mapping:read')
  @Get('v1/role-permissions/:id')
  getRolePermission(@Param('id') id: string) {
    return this.security.getRolePermissionById(id);
  }

  @Permissions('iam:role_permission_mapping:write')
  @Post('v1/role-permissions')
  createRolePermission(
    @Body(new ZodValidationPipe(createRolePermissionBody))
    body: CreateRolePermissionBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.security.createRolePermission(body, principal);
  }

  @Permissions('iam:role_permission_mapping:write')
  @Delete('v1/role-permissions/:id')
  revokeRolePermission(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.security.revokeRolePermission(id, principal);
  }

  // ── user_role_mapping ─────────────────────────────────────────────────────
  @Permissions('iam:user_role_mapping:read')
  @Get('v1/user-roles')
  listUserRoles(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.security.listUserRoles(query);
  }

  @Permissions('iam:user_role_mapping:read')
  @Get('v1/user-roles/:id')
  getUserRole(@Param('id') id: string) {
    return this.security.getUserRoleById(id);
  }

  @Permissions('iam:user_role_mapping:write')
  @Post('v1/user-roles')
  createUserRole(
    @Body(new ZodValidationPipe(createUserRoleBody)) body: CreateUserRoleBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.security.createUserRole(body, principal);
  }

  @Permissions('iam:user_role_mapping:write')
  @Delete('v1/user-roles/:id')
  revokeUserRole(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.security.revokeUserRole(id, principal);
  }

  // ── vault_role_grant_request (S2 security review item A: two-person control on assigning
  // formulator/vault_approver — POST /v1/user-roles above opens the PENDING request when the
  // target role is Vault-authority; these routes are the approve/cancel second half) ─────────
  @Permissions('iam:user_role_mapping:read')
  @Get('v1/vault-role-grant-requests')
  listVaultRoleGrantRequests(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.security.listVaultRoleGrantRequests(query);
  }

  @Permissions('iam:user_role_mapping:read')
  @Get('v1/vault-role-grant-requests/:id')
  getVaultRoleGrantRequest(@Param('id') id: string) {
    return this.security.getVaultRoleGrantRequestById(id);
  }

  @Permissions('iam:user_role_mapping:write')
  @Post('v1/vault-role-grant-requests/:id/approve')
  approveVaultRoleGrant(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.security.approveVaultRoleGrant(id, principal);
  }

  @Permissions('iam:user_role_mapping:write')
  @Post('v1/vault-role-grant-requests/:id/cancel')
  cancelVaultRoleGrant(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.security.cancelVaultRoleGrant(id, principal);
  }

  // ── location_authority_master ─────────────────────────────────────────────
  @Permissions('iam:location_authority_master:read')
  @Get('v1/location-authorities')
  listLocationAuthorities(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.security.listLocationAuthorities(query);
  }

  @Permissions('iam:location_authority_master:read')
  @Get('v1/location-authorities/:id')
  getLocationAuthority(@Param('id') id: string) {
    return this.security.getLocationAuthorityById(id);
  }

  @Permissions('iam:location_authority_master:write')
  @Post('v1/location-authorities')
  createLocationAuthority(
    @Body(new ZodValidationPipe(createLocationAuthorityBody))
    body: CreateLocationAuthorityBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.security.createLocationAuthority(body, principal);
  }
}
