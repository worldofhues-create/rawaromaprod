/**
 * AppModule — the HTTP composition root (doc 01 §0 deployment shape: the `api` process).
 *
 * Imports the reusable kernel (config, db, jwt, flags, event bus, health) + the Phase-1
 * clusters (identity, platform), and installs the edge layer globally:
 *   - guards (order matters): JwtAuthGuard → PermissionsGuard → FreshAuthGuard → FlagGuard
 *   - ResponseEnvelopeInterceptor (every success → { data, meta, error })
 *   - AllExceptionsFilter (every error → normalized envelope)
 *   - RequestIdMiddleware (x-request-id on every route)
 * Adding a cluster = one import line here (plus its package).
 */
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  AllExceptionsFilter,
  BackendKernelModule,
  FlagGuard,
  FreshAuthGuard,
  JwtAuthGuard,
  PermissionsGuard,
  RequestIdMiddleware,
  ResponseEnvelopeInterceptor,
} from '@core/backend-kernel';
import { PlatformModule } from '@core/cluster-platform';
// RA Phase-1A dictionary clusters (added as each is built on the new schema).
// Auth is dictionary-backed (cluster-org, on USER_MASTER) — the generic @core identity
// cluster is retired for RA.
import { ClusterOrgModule } from '@ra/cluster-org';
import { ReferenceModule } from '@ra/cluster-reference';
import { LocationModule } from '@ra/cluster-location';
import { ClusterMasterdataModule } from '@ra/cluster-masterdata';
import { ClusterProcurementModule } from '@ra/cluster-procurement';
import { ClusterInventoryModule } from '@ra/cluster-inventory';
import { QualityModule } from '@ra/cluster-quality';
import { FormulaModule } from '@ra/cluster-formula';
import { ProductionModule } from '@ra/cluster-production';
import { PackagingModule } from '@ra/cluster-packaging';
import { SalesModule } from '@ra/cluster-sales';
import { MaterialMaskingInterceptor } from './masking/material-masking.interceptor.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { PackagingQcModule } from './packaging-qc/packaging-qc.module.js';
import { InventoryViewModule } from './inventory-view/inventory-view.module.js';
import { FgStockModule } from './fg-stock/fg-stock.module.js';
import { EditModule } from './edit/edit.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { PlanningModule } from './planning/planning.module.js';
import { AuditModule } from './audit/audit.module.js';
import { SearchModule } from './search/search.module.js';
import { GeoModule } from './geo/geo.module.js';
import { ProcAnalyticsModule } from './procanalytics/procanalytics.module.js';
import { OrgUnitsModule } from './orgunits/orgunits.module.js';
import { DispatchDocsModule } from './dispatchdocs/dispatchdocs.module.js';
import { RelayModule } from './relay/relay.module.js';
import { BridgeModule } from './bridge/bridge.module.js';
import { FactsModule } from './facts/facts.module.js';
import { PlatformOpsModule } from './platform-ops/platform-ops.module.js';
import { MaterialFactsModule } from './vault-bridge/material-facts.module.js';

@Module({
  imports: [
    BackendKernelModule.forRoot(),
    CryptoModule,
    PlatformModule,
    ClusterOrgModule,
    ReferenceModule,
    LocationModule,
    ClusterMasterdataModule,
    ClusterProcurementModule,
    ClusterInventoryModule,
    QualityModule,
    FormulaModule,
    ProductionModule,
    PackagingModule,
    SalesModule,
    DashboardModule,
    PackagingQcModule,
    InventoryViewModule,
    FgStockModule,
    EditModule,
    DocumentsModule,
    PlanningModule,
    AuditModule,
    SearchModule,
    GeoModule,
    ProcAnalyticsModule,
    OrgUnitsModule,
    DispatchDocsModule,
    RelayModule,
    BridgeModule,
    FactsModule,
    PlatformOpsModule,
    // PB-03 remainder (V4 §109.1) — serves the Vault box's material-facts bridge (RM_ALIAS/
    // search only, InternalBridgeGuard-signed, @Public); the Vault's own plaintext formula
    // routes are never mounted here (FormulaModule stays VAULT_MODE=false in this process).
    MaterialFactsModule,
  ],
  providers: [
    // Edge guards run in registration order: authenticate, then authorize, then step-up
    // (§109.5), then flag-gate.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: FreshAuthGuard },
    { provide: APP_GUARD, useClass: FlagGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    // Registered AFTER the envelope → on the response path it runs FIRST, masking material_id
    // on the raw handler output before the envelope wraps it. Floor sees aliases, never real ids.
    { provide: APP_INTERCEPTOR, useClass: MaterialMaskingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
