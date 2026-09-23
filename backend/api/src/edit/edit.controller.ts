/**
 * EditController — PATCH /v1/masters/:resource/:id. Auth is required (edge guard); the SPECIFIC
 * write-permission is enforced per-resource inside EditService against the caller's token, so a
 * static @Permissions decorator (which can't vary by :resource) isn't used here.
 */
import { Body, Controller, Param, Patch } from '@nestjs/common';
import { CurrentUser, DynamicPermission, type AuthPrincipal } from '@core/backend-kernel';
import { EditService } from './edit.service.js';

@Controller()
export class EditController {
  constructor(private readonly svc: EditService) {}

  @DynamicPermission('REGISTRY[resource].perm checked in EditService.update before any read/write')
  @Patch('v1/masters/:resource/:id')
  update(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.svc.update(resource, id, body, principal);
  }
}
