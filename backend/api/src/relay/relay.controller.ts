/**
 * RelayController — the air-gap crossing endpoints. Owner/admin only (reuses platform:flag:write,
 * an existing governance permission → no RBAC reseed). export produces a signed package from the
 * outbox; import verifies + dedupes a package; status shows cursors, pending counts, and the chain.
 * In a true two-console deploy, export runs on one console and import on the other, carried by
 * USB / diode / forwarder — the DBs never connect. Bodies are validated in the service.
 */
import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { Permissions } from '@core/backend-kernel';
import { RelayService, type RelayPackage } from './relay.service.js';
import { isRelayDirection } from './relay-contract.js';

@Controller()
export class RelayController {
  constructor(private readonly relay: RelayService) {}

  @Permissions('platform:flag:write')
  @Post('v1/relay/export')
  exportPackage(@Body() body: { direction?: unknown; commit?: unknown }) {
    if (!isRelayDirection(body?.direction)) {
      throw new BadRequestException('direction must be "online-to-offline" or "offline-to-online".');
    }
    return this.relay.exportPackage(body.direction, body.commit !== false);
  }

  @Permissions('platform:flag:write')
  @Post('v1/relay/import')
  importPackage(@Body() body: RelayPackage) {
    return this.relay.importPackage(body);
  }

  @Permissions('platform:flag:write')
  @Get('v1/relay/status')
  status() {
    return this.relay.status();
  }
}
