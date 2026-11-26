/**
 * PlatformOpsController — the Platform Ops console's backend (§6/§113). Every route here is
 * gated on `platformops:console:read`, held ONLY by `platform_super_admin` and `owner` in
 * scripts/ra-roles.ts (PLATFORM_OPS_ROLES) — see PlatformOpsService for what "fail closed for
 * everyone else" covers). None of these routes touch tenant business data or Formula Vault plaintext;
 * PlatformOpsService's doc comment says exactly what each one reads and why it's safe.
 */
import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Permissions } from '@core/backend-kernel';
import { PlatformOpsService } from './platform-ops.service.js';
import { BridgeHealthService } from './bridge-health.service.js';
import { PlatformReadsService } from './platform-reads.service.js';
import { HealthSamplerService } from './health-sampler.service.js';

@Controller('v1/platform')
export class PlatformOpsController {
  constructor(
    private readonly ops: PlatformOpsService,
    private readonly bridge: BridgeHealthService,
    private readonly reads: PlatformReadsService,
    private readonly sampler: HealthSamplerService,
  ) {}

  /** Lane produce: the ALEMBIC bridge's health and counters (counts/timestamps only). */
  @Permissions('platformops:console:read')
  @Get('bridge')
  bridgeHealth() {
    return this.bridge.health();
  }

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

  /* ── B09 (STUB-075): the readings the RAC OS Platform console asked for and this box did not have.
     Read only; the verify is a POST because it computes on request, and it writes nothing
     (platform-reads.service.ts says what each one reads and what it never returns). ── */

  /** The main box's link to the Vault and the Vault's own verdict (never its address). */
  @Permissions('platformops:console:read')
  @Get('vault-health')
  vaultHealth() {
    return this.reads.vaultHealth();
  }

  /** The tiles' history: one sample every 30 s, held in memory for 7 days (health-sampler.service.ts). */
  @Permissions('platformops:console:read')
  @Get('health/samples')
  healthSamples(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.sampler.samples({ limit, cursor });
  }

  /** The main box's hash chain by month, each month walked on this read. */
  @Permissions('platformops:console:read')
  @Get('audit-chain')
  auditChain(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.reads.auditChain({ limit, cursor });
  }

  /** Walk the whole chain and name the first break. Recomputes and compares; repairs nothing. */
  @Permissions('platformops:console:read')
  @Post('audit-chain/verify')
  @HttpCode(200)
  verifyAuditChain() {
    return this.reads.verifyChain();
  }
}

/**
 * B09 (STUB-075): the RawProd -> RAC OS events for the Platform console's "Sales system link"
 * screen, parked first or all, paged, never a payload. At the address the console was built against
 * (`/v1/bridge/outbox`, beside bridge.controller.ts's `/v1/bridge/outbox/parked` and its replay and
 * discard, which stay where they are and are not reached from RAC OS).
 */
@Controller('v1/bridge/outbox')
export class PlatformOutboxController {
  constructor(private readonly reads: PlatformReadsService) {}

  @Permissions('platformops:console:read')
  @Get()
  list(@Query('state') state?: string, @Query('q') q?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.reads.outbox({ state, q, cursor, limit });
  }
}
