/**
 * PlatformOpsController — the Platform Ops console's backend (§6/§113). Every route here is
 * `platform_super_admin`-only (`platformops:console:read`, held by no other role in
 * scripts/ra-roles.ts — see PlatformOpsService for what "fail closed for everyone else"
 * covers). None of these routes touch tenant business data or Formula Vault plaintext;
 * PlatformOpsService's doc comment says exactly what each one reads and why it's safe.
 */
import { Controller, Get } from '@nestjs/common';
import { Permissions } from '@core/backend-kernel';
import { PlatformOpsService } from './platform-ops.service.js';

@Controller('v1/platform')
export class PlatformOpsController {
  constructor(private readonly ops: PlatformOpsService) {}

  @Permissions('platformops:console:read')
  @Get('tenants')
  tenants() {
    return this.ops.tenants();
  }

  @Permissions('platformops:console:read')
  @Get('health')
  health() {
    return this.ops.deepHealth();
  }

  @Permissions('platformops:console:read')
  @Get('providers')
  providers() {
    return this.ops.providers();
  }

  @Permissions('platformops:console:read')
  @Get('build')
  build() {
    return this.ops.buildIdentity();
  }
}
