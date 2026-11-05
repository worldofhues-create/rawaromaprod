/**
 * PROD-A-1 — the admin Rules screen's routes (production-floor plan §12.0). Reading and testing a
 * policy is `platform:policy:read`; publishing a version is `platform:policy:write`; a single-record
 * override is `platform:policy_override:write` AND an admin/owner role (PolicyService re-checks).
 */
import { Body, ConflictException, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { PolicyService, PolicyUnresolved } from './policy.service.js';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

@Controller()
export class PolicyController {
  constructor(private readonly policies: PolicyService) {}

  @Permissions('platform:policy:read')
  @Get('v1/policies')
  list() {
    return this.policies.list();
  }

  @Permissions('platform:policy:read')
  @Get('v1/policies/:key')
  history(@Param('key') key: string) {
    return this.policies.history(key);
  }

  @Permissions('platform:policy:read')
  @Post('v1/policies/:key/test')
  test(@Param('key') key: string, @Body() body: { body?: unknown; ctx?: unknown }) {
    return this.policies.test(key, body?.body, obj(body?.ctx));
  }

  /** What the version in force answers for a case. A HOLD is a 409 the caller must act on. */
  @Permissions('platform:policy:read')
  @Post('v1/policies/:key/evaluate')
  async evaluate(@Param('key') key: string, @Body() body: { ctx?: unknown; at?: unknown }) {
    const at = typeof body?.at === 'string' && body.at ? new Date(body.at) : undefined;
    try {
      return await this.policies.evaluate(key, obj(body?.ctx), at && !Number.isNaN(at.getTime()) ? at : undefined);
    } catch (e) {
      if (e instanceof PolicyUnresolved) throw new ConflictException({ message: e.message, code: e.code });
      throw e;
    }
  }

  @Permissions('platform:policy:write')
  @Post('v1/policies/:key/versions')
  publish(@Param('key') key: string, @Body() body: { body?: unknown; reason?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    return this.policies.publish(key, body?.body, String(body?.reason ?? ''), principal);
  }

  @Permissions('platform:policy_override:write')
  @Post('v1/policies/:key/overrides')
  override(@Param('key') key: string, @Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.policies.override(key, String(body?.recordType ?? ''), String(body?.recordId ?? ''), body?.value, String(body?.reason ?? ''), principal);
  }

  @Permissions('platform:policy_override:write')
  @Post('v1/policy-overrides/:id/revoke')
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() body: { reason?: unknown }, @CurrentUser() principal: AuthPrincipal) {
    return this.policies.revokeOverride(id, String(body?.reason ?? ''), principal);
  }
}
