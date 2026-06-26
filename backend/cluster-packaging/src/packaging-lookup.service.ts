/**
 * PackagingLookupService — in-cluster implementation of the `PackagingLookup` public port.
 * Provided under `PACKAGING_LOOKUP` so consumers depend only on the interface, never on a
 * concrete class. Keyed selects returning a package order ref + a finished-good batch ref.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PACKAGING_DB, packagingSchema, type PackagingDb } from './packaging.tokens.js';
import type {
  FinishedGoodBatchRef,
  PackageOrderRef,
  PackagingLookup,
} from './public-api.js';

const { packageOrder, finishedGoodBatchMaster } = packagingSchema;

@Injectable()
export class PackagingLookupService implements PackagingLookup {
  constructor(@Inject(PACKAGING_DB) private readonly db: PackagingDb) {}

  async getPackageOrder(packageOrderId: string): Promise<PackageOrderRef | null> {
    const row = (
      await this.db
        .select({
          packageOrderId: packageOrder.packageOrderId,
          productSkuId: packageOrder.productSkuId,
          oilBatchId: packageOrder.oilBatchId,
          status: packageOrder.status,
        })
        .from(packageOrder)
        .where(eq(packageOrder.packageOrderId, packageOrderId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async getFinishedGoodBatch(
    finishedGoodBatchId: string,
  ): Promise<FinishedGoodBatchRef | null> {
    const row = (
      await this.db
        .select({
          finishedGoodBatchId: finishedGoodBatchMaster.finishedGoodBatchId,
          batchNumber: finishedGoodBatchMaster.batchNumber,
          producedQty: finishedGoodBatchMaster.producedQty,
          productSkuId: finishedGoodBatchMaster.productSkuId,
          status: finishedGoodBatchMaster.status,
        })
        .from(finishedGoodBatchMaster)
        .where(eq(finishedGoodBatchMaster.finishedGoodBatchId, finishedGoodBatchId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
