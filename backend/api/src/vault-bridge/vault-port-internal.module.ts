/**
 * VaultPortInternalModule — mounts `VaultPortInternalController` (Vault box only; see that
 * file's header). Imported by `VaultAppModule`. Needs no providers of its own —
 * `FORMULA_LOOKUP` comes from `FormulaModule` (Global, already imported by `VaultAppModule`).
 */
import { Module } from '@nestjs/common';
import { VaultPortInternalController } from './vault-port-internal.controller.js';

@Module({
  controllers: [VaultPortInternalController],
})
export class VaultPortInternalModule {}
