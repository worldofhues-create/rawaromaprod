/**
 * BatchService — CRUD over the RM-batch genealogy tables (RM_BATCH_MASTER,
 * BATCH_CONTAINER_MAPPINGS, BATCH_GENEALOGY_HISTORY) plus the batch-release flow.
 * releaseRmBatch projects an RM batch into the live ledger: it creates an inventory_batch,
 * an inventory_transaction (type RECEIVE) and an inventory_event_history row, all in one
 * transaction. numeric → String(n); date columns kept as ISO strings; timestamps → Date.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
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
            // lane/j2: random tail, not the uuidv7 timestamp head (see grn.service.ts shortId).
            batchNumber: body.batchNumber ?? `RMB-${uuidv7().replace(/-/g, '').slice(-12).toUpperCase()}`,
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

  async listRmBatches(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // FEFO indication: surface the expiry date + a flag (EXPIRED / EXPIRING within 30d / OK) so
    // the floor can consume earliest-expiry stock first. material_id is kept (the global masking
    // interceptor still nulls it + adds the alias for non-reveal roles); no real material name is
    // added here, so the masking boundary is preserved. Pagination stays id-cursored.
    const rows = (await this.db.execute(sql`
      select b.rm_batch_id as "rmBatchId", b.batch_number as "batchNumber", b.material_id as "materialId",
             b.received_qty as "receivedQty", b.manufacturing_date as "manufacturingDate", b.expiry_date as "expiryDate",
             case when b.expiry_date is null then null
                  when b.expiry_date < now() then 'EXPIRED'
                  when b.expiry_date <= now() + interval '30 days' then 'EXPIRING'
                  else 'OK' end as "fefoFlag",
             b.storage_location_id as "storageLocationId", b.status as "status"
        from inventory.rm_batch_master b
       ${query.cursor ? sql`where b.rm_batch_id < ${query.cursor}` : sql``}
       order by b.rm_batch_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.rmBatchId as string);
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
  ): Promise<Page<Record<string, unknown>>> {
    const rows = (await this.db.execute(sql`
      select bcm.batch_container_mapping_id as "batchContainerMappingId",
             bcm.rm_batch_id as "rmBatchId", b.batch_number as "batchNumber",
             bcm.grn_container_id as "grnContainerId", c.container_code as "containerCode",
             bcm.status as "status"
        from inventory.batch_container_mappings bcm
        left join inventory.rm_batch_master b on b.rm_batch_id = bcm.rm_batch_id
        left join inventory.grn_container c on c.grn_container_id = bcm.grn_container_id
       ${query.cursor ? sql`where bcm.batch_container_mapping_id < ${query.cursor}` : sql``}
       order by bcm.batch_container_mapping_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.batchContainerMappingId as string);
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
      if (!rmBatch) throw new NotFoundException(`rm_batch_master not found: ${id}`);
      // Idempotency (audit H-C4): a batch already released must not be projected into the ledger
      // again — a second release would create a second inventory_batch and double-count on-hand.
      if (String(rmBatch.status ?? '').toUpperCase() === 'RELEASED') {
        throw new ConflictException(`RM batch ${rmBatch.batchNumber ?? id} is already released to stock.`);
      }

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

      // Flip the RM batch to RELEASED so it can't be double-released (idempotency + the UI
      // "Release to stock" guard, which keys off this status, now actually works).
      await tx
        .update(rmBatchMaster)
        .set({ status: 'RELEASED', updatedBy: principal.userId })
        .where(eq(rmBatchMaster.rmBatchId, id));

      return { inventoryBatch: invBatch, transaction: txn, history };
    });
  }
}
