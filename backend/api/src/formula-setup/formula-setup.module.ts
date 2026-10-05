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
import { FORMULA_SETUP_DB, formulaSetupDb } from './formula-setup.tokens.js';

@Module({
  imports: [ClusterOrgModule],
  controllers: [FormulaSetupController],
  providers: [
    { provide: FORMULA_SETUP_DB, inject: [PG_CLIENT], useFactory: (client: Sql) => formulaSetupDb(client) },
    FormulaSetupService,
    // PRODUCT_KIND_SOURCE: provide the catalogue's classification reader here once lane
    // catalogue-rp settles where it stores single_chemical/blend (formula-setup.tokens.ts).
  ],
})
export class FormulaSetupModule {}
