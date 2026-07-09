/**
 * PackagingLookupService — in-cluster implementation of the `PackagingLookup` public port.
 * Provided under `PACKAGING_LOOKUP` so consumers depend only on the interface, never on a
 * concrete class. Keyed selects returning a package order ref + a finished-good batch ref.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PACKAGING_DB, packagingSchema, type PackagingDb } from './packaging.tokens.js';
import type {
  FinishedGoodBatchRef,
  FinishedGoodStockRef,
  PackageOrderRef,
  PackagingLookup,
} from './public-api.js';

const { packageOrder, finishedGoodBatchMaster, finishedGoodReservation } = packagingSchema;

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

  async getFinishedGoodStock(
    finishedGoodBatchId: string,
  ): Promise<FinishedGoodStockRef | null> {
    const batch = (
      await this.db
        .select({
          finishedGoodBatchId: finishedGoodBatchMaster.finishedGoodBatchId,
          producedQty: finishedGoodBatchMaster.producedQty,
        })
        .from(finishedGoodBatchMaster)
        .where(eq(finishedGoodBatchMaster.finishedGoodBatchId, finishedGoodBatchId))
        .limit(1)
    )[0];
    if (!batch) return null;

    // Sum ACTIVE reservations (released_dt IS NULL). coalesce → '0' when none.
    const reserved = (
      await this.db
        .select({
          total: sql<string>`coalesce(sum(${finishedGoodReservation.reservedQty}), 0)::text`,
        })
        .from(finishedGoodReservation)
        .where(
          and(
            eq(finishedGoodReservation.finishedGoodBatchId, finishedGoodBatchId),
            isNull(finishedGoodReservation.releasedDt),
          ),
        )
    )[0];

    return {
      finishedGoodBatchId: batch.finishedGoodBatchId,
      producedQty: batch.producedQty,
      reservedQty: reserved?.total ?? '0',
    };
  }
}
