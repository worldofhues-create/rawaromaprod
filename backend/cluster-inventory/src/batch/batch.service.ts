/**
 * BatchService — CRUD over the RM-batch genealogy tables (RM_BATCH_MASTER,
 * BATCH_CONTAINER_MAPPINGS, BATCH_GENEALOGY_HISTORY) plus the batch-release flow.
 * releaseRmBatch projects an RM batch into the live ledger: it creates an inventory_batch,
 * an inventory_transaction (type RECEIVE) and an inventory_event_history row, all in one
 * transaction. numeric → String(n); date columns kept as ISO strings; timestamps → Date.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import {
  INVENTORY_DB,
  inventorySchema,
  type InventoryDb,
} from '../cluster-inventory.tokens.js';
import type { Page, ListQuery } from '../cluster-inventory.dtos.js';
import type {
  CreateBatchContainerMapping,
  CreateBatchGenealogyHistory,
  CreateRmBatch,
  ReleaseRmBatch,
} from '../cluster-inventory.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const {
  rmBatchMaster,
  batchContainerMappings,
  batchGenealogyHistory,
  inventoryBatch,
  inventoryTransaction,
  inventoryEventHistory,
} = inventorySchema;

@Injectable()
export class BatchService {
  constructor(@Inject(INVENTORY_DB) private readonly db: InventoryDb) {}

  /* ── rm_batch_master ────────────────────────────────────────────────── */

  async createRmBatch(body: CreateRmBatch, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(rmBatchMaster)
          .values({
            grnItemId: body.grnItemId ?? null,
            materialId: body.materialId ?? null,
            batchNumber: body.batchNumber ?? `RMB-${uuidv7().split('-')[0]!.toUpperCase()}`,
            manufacturingDate: body.manufacturingDate ?? null,
            expiryDate: body.expiryDate ?? null,
            receivedQty: body.receivedQty != null ? String(body.receivedQty) : null,
            uomId: body.uomId ?? null,
            storageLocationId: body.storageLocationId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listRmBatches(query: ListQuery): Promise<Page<typeof rmBatchMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(rmBatchMaster)
      .where(query.cursor ? lt(rmBatchMaster.rmBatchId, query.cursor) : undefined)
      .orderBy(desc(rmBatchMaster.rmBatchId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.rmBatchId);
  }

  async getRmBatch(id: string) {
    return (
      (
        await this.db
          .select()
          .from(rmBatchMaster)
          .where(eq(rmBatchMaster.rmBatchId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── batch_container_mappings ───────────────────────────────────────── */

  async createBatchContainerMapping(
    body: CreateBatchContainerMapping,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(batchContainerMappings)
          .values({
            rmBatchId: body.rmBatchId ?? null,
            grnContainerId: body.grnContainerId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listBatchContainerMappings(
    query: ListQuery,
  ): Promise<Page<typeof batchContainerMappings.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(batchContainerMappings)
      .where(
        query.cursor
          ? lt(batchContainerMappings.batchContainerMappingId, query.cursor)
          : undefined,
      )
      .orderBy(desc(batchContainerMappings.batchContainerMappingId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.batchContainerMappingId);
  }

  async getBatchContainerMapping(id: string) {
    return (
      (
        await this.db
          .select()
          .from(batchContainerMappings)
          .where(eq(batchContainerMappings.batchContainerMappingId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── batch_genealogy_history ────────────────────────────────────────── */

  async createBatchGenealogyHistory(
    body: CreateBatchGenealogyHistory,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(batchGenealogyHistory)
          .values({
            finishedGoodBatchId: body.finishedGoodBatchId ?? null,
            oilBatchId: body.oilBatchId ?? null,
            rmBatchId: body.rmBatchId ?? null,
            relationshipType: body.relationshipType ?? null,
            recordedDt: body.recordedDt ? new Date(body.recordedDt) : new Date(),
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listBatchGenealogyHistories(
    query: ListQuery,
  ): Promise<Page<typeof batchGenealogyHistory.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(batchGenealogyHistory)
      .where(
        query.cursor
          ? lt(batchGenealogyHistory.batchGenealogyHistoryId, query.cursor)
          : undefined,
      )
      .orderBy(desc(batchGenealogyHistory.batchGenealogyHistoryId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.batchGenealogyHistoryId);
  }

  async getBatchGenealogyHistory(id: string) {
    return (
      (
        await this.db
          .select()
          .from(batchGenealogyHistory)
          .where(eq(batchGenealogyHistory.batchGenealogyHistoryId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── FLOW: RM batch release → inventory_batch + RECEIVE txn + history ── */

  async releaseRmBatch(id: string, body: ReleaseRmBatch, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const rmBatch = (
        await tx
          .select()
          .from(rmBatchMaster)
          .where(eq(rmBatchMaster.rmBatchId, id))
          .limit(1)
      )[0];
      if (!rmBatch) throw new Error(`rm_batch_master not found: ${id}`);

      const quantity =
        body.quantity != null
          ? String(body.quantity)
          : rmBatch.receivedQty ?? null;
      const uomId = body.uomId ?? rmBatch.uomId ?? null;
      const storageLocationId = body.storageLocationId ?? rmBatch.storageLocationId ?? null;
      const now = new Date();

      const inventoryBatchId = uuidv7();
      const invBatch = ensure(
        (
          await tx
            .insert(inventoryBatch)
            .values({
              inventoryBatchId,
              rmBatchId: id,
              materialId: rmBatch.materialId,
              storageLocationId,
              inventoryStatusId: body.inventoryStatusId ?? null,
              quantityOnHand: quantity,
              uomId,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      const inventoryTransactionId = uuidv7();
      const txn = ensure(
        (
          await tx
            .insert(inventoryTransaction)
            .values({
              inventoryTransactionId,
              inventoryBatchId,
              inventoryTransactionTypeId: body.inventoryTransactionTypeId ?? null,
              transactionQty: quantity,
              uomId,
              fromLocationId: null,
              toLocationId: storageLocationId,
              transactionDt: now,
              referenceDocumentId: body.referenceDocumentId ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      const history = ensure(
        (
          await tx
            .insert(inventoryEventHistory)
            .values({
              inventoryBatchId,
              eventType: 'RECEIVE',
              eventDt: now,
              inventoryTransactionId,
              referenceDocumentId: body.referenceDocumentId ?? id,
              referenceDocumentType: 'RM_BATCH',
              performedBy: principal.userId,
              remarks: body.remarks ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      return { inventoryBatch: invBatch, transaction: txn, history };
    });
  }
}
