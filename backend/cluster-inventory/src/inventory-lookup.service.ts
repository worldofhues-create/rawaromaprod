/**
 * InventoryLookupService — in-cluster implementation of the `InventoryLookup` public port.
 * Provided under `INVENTORY_LOOKUP` so consumers depend only on the interface. Cold-read
 * resolvers return id + ref values only — no meta tail, no bodies.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  INVENTORY_DB,
  inventorySchema,
  type InventoryDb,
} from './cluster-inventory.tokens.js';
import type {
  InventoryBatchRef,
  InventoryLookup,
  RmBatchRef,
} from './public-api.js';

const { rmBatchMaster, inventoryBatch } = inventorySchema;

@Injectable()
export class InventoryLookupService implements InventoryLookup {
  constructor(@Inject(INVENTORY_DB) private readonly db: InventoryDb) {}

  async findRmBatch(rmBatchId: string): Promise<RmBatchRef | null> {
    const row = (
      await this.db
        .select({
          rmBatchId: rmBatchMaster.rmBatchId,
          materialId: rmBatchMaster.materialId,
          batchNumber: rmBatchMaster.batchNumber,
          status: rmBatchMaster.status,
        })
        .from(rmBatchMaster)
        .where(eq(rmBatchMaster.rmBatchId, rmBatchId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findInventoryBatch(
    inventoryBatchId: string,
  ): Promise<InventoryBatchRef | null> {
    const row = (
      await this.db
        .select({
          inventoryBatchId: inventoryBatch.inventoryBatchId,
          rmBatchId: inventoryBatch.rmBatchId,
          quantityOnHand: inventoryBatch.quantityOnHand,
        })
        .from(inventoryBatch)
        .where(eq(inventoryBatch.inventoryBatchId, inventoryBatchId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
