/**
 * AriaBridgeModule (UX-H) — `PG_CLIENT` from the global kernel module, `BRIDGE_DB` from the
 * global `BridgeModule` (the connector row whose sealed secret signs the forward). Main app
 * box only: the Vault console reaches it over its existing MAIN_API channel, and
 * `VaultAppModule` never imports it (the Vault EC2 holds no bridge secret).
 */
import { Module } from '@nestjs/common';
import { AriaBridgeController } from './aria-bridge.controller.js';
import { AriaBridgeService } from './aria-bridge.service.js';

@Module({
  controllers: [AriaBridgeController],
  providers: [AriaBridgeService],
})
export class AriaBridgeModule {}
