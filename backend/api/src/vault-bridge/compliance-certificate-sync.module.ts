/**
 * ComplianceCertificateSyncModule — the main box's worker job that pulls the Vault's calculated
 * IFRA/allergen certificates and emits them toward ALEMBIC (`ComplianceCertificateSyncService`;
 * see its header). Imported by `WorkerModule`. `BRIDGE_DB` comes from the global `BridgeModule`,
 * `VaultApiClient` from the global `VaultPortModule` (ProductionModule imports it).
 */
import { Module } from '@nestjs/common';
import { ComplianceCertificateSyncService } from './compliance-certificate-sync.service.js';

@Module({
  providers: [ComplianceCertificateSyncService],
})
export class ComplianceCertificateSyncModule {}
