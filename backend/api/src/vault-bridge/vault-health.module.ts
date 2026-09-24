import { Module } from '@nestjs/common';
import { VaultHealthController } from './vault-health.controller.js';

/** Mounts `/health` for `vault-main.ts`. Imported by `VaultAppModule` only. */
@Module({
  controllers: [VaultHealthController],
})
export class VaultHealthModule {}
