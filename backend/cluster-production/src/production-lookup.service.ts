/**
 * ProductionLookupService — in-cluster implementation of the `ProductionLookup` public port.
 * Provided under `PRODUCTION_LOOKUP` so consumers depend only on the interface. Keyed selects
 * returning id + key scalars (no bill-of-materials, no formula data).
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from './production.tokens.js';
import type { OilBatchRef, OrderRef, ProductionLookup } from './public-api.js';

const { productionOrder, oilBatchMaster } = productionSchema;

@Injectable()
export class ProductionLookupService implements ProductionLookup {
  constructor(@Inject(PRODUCTION_DB) private readonly db: ProductionDb) {}

  async getOrder(productionOrderId: string): Promise<OrderRef | null> {
    const row = (
      await this.db
        .select({
          productionOrderId: productionOrder.productionOrderId,
          formulaVersionId: productionOrder.formulaVersionId,
          orderQty: productionOrder.orderQty,
          status: productionOrder.status,
        })
        .from(productionOrder)
        .where(eq(productionOrder.productionOrderId, productionOrderId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async getOilBatch(oilBatchId: string): Promise<OilBatchRef | null> {
    const row = (
      await this.db
        .select({
          oilBatchId: oilBatchMaster.oilBatchId,
          productionOrderId: oilBatchMaster.productionOrderId,
          batchNumber: oilBatchMaster.batchNumber,
          producedQty: oilBatchMaster.producedQty,
          status: oilBatchMaster.status,
        })
        .from(oilBatchMaster)
        .where(eq(oilBatchMaster.oilBatchId, oilBatchId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
