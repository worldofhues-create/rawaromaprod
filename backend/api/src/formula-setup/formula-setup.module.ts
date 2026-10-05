/**
 * FormulaSetupModule (lane vaultsetup) — the factory's formula-setup screen: products and their
 * formula state, "Draft formula shells" (as the Ruh service principal), the guarded product ->
 * formula link, and the formula list the Factory's Formula dropdowns read. Registered by
 * app.module.ts. See formula-setup.service.ts.
 */
import { Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { ClusterOrgModule } from '@ra/cluster-org';
import { FormulaSetupController } from './formula-setup.controller.js';
import { FormulaSetupService } from './formula-setup.service.js';
import { FORMULA_SETUP_DB, PRODUCT_KIND_SOURCE, formulaSetupDb } from './formula-setup.tokens.js';
import { CatalogueProductKindSource } from './catalogue-kind.source.js';

@Module({
  imports: [ClusterOrgModule],
  controllers: [FormulaSetupController],
  providers: [
    { provide: FORMULA_SETUP_DB, inject: [PG_CLIENT], useFactory: (client: Sql) => formulaSetupDb(client) },
    FormulaSetupService,
    // The catalogue's single_chemical/blend classification (bridge.catalogue_item, lane catalogue-rp).
    { provide: PRODUCT_KIND_SOURCE, useClass: CatalogueProductKindSource },
  ],
})
export class FormulaSetupModule {}
