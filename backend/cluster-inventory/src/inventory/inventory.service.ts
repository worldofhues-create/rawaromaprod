/**
 * InventoryService — the event-sourced inventory ledger: CRUD over INVENTORY_STATUS_MASTER,
 * INVENTORY_BATCH, INVENTORY_TRANSACTION_TYPE_MASTER, INVENTORY_TRANSACTION and
 * INVENTORY_EVENT_HISTORY. createInventoryTransaction is the ledger write: each
 * ISSUE/TRANSFER/ADJUSTMENT (the event_type carried in the body) records the transaction +
 * an inventory_event_history row in one transaction. numeric → String(n); timestamps → Date.
 */
import { Inject, Injectable } from '@nestjs/common';
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
  CreateInventoryBatch,
  CreateInventoryEventHistory,
  CreateInventoryStatus,
  CreateInventoryTransaction,
  CreateInventoryTransactionType,
} from '../cluster-inventory.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const {
  inventoryStatusMaster,
  inventoryBatch,
  inventoryTransactionTypeMaster,
  inventoryTransaction,
  inventoryEventHistory,
} = inventorySchema;

@Injectable()
export class InventoryService {
  constructor(@Inject(INVENTORY_DB) private readonly db: InventoryDb) {}

  /* ── inventory_status_master ────────────────────────────────────────── */

  async createInventoryStatus(body: CreateInventoryStatus, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(inventoryStatusMaster)
          .values({
            statusCode: body.statusCode ?? null,
            statusName: body.statusName ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listInventoryStatuses(
    query: ListQuery,
  ): Promise<Page<typeof inventoryStatusMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(inventoryStatusMaster)
      .where(
        query.cursor ? lt(inventoryStatusMaster.inventoryStatusId, query.cursor) : undefined,
      )
      .orderBy(desc(inventoryStatusMaster.inventoryStatusId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.inventoryStatusId);
  }

  async getInventoryStatus(id: string) {
    return (
      (
        await this.db
          .select()
          .from(inventoryStatusMaster)
          .where(eq(inventoryStatusMaster.inventoryStatusId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── inventory_batch ────────────────────────────────────────────────── */

  async createInventoryBatch(body: CreateInventoryBatch, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(inventoryBatch)
          .values({
            rmBatchId: body.rmBatchId ?? null,
            materialId: body.materialId ?? null,
            storageLocationId: body.storageLocationId ?? null,
            inventoryStatusId: body.inventoryStatusId ?? null,
            quantityOnHand:
              body.quantityOnHand != null ? String(body.quantityOnHand) : null,
            uomId: body.uomId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listInventoryBatches(
    query: ListQuery,
  ): Promise<Page<typeof inventoryBatch.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(inventoryBatch)
      .where(query.cursor ? lt(inventoryBatch.inventoryBatchId, query.cursor) : undefined)
      .orderBy(desc(inventoryBatch.inventoryBatchId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.inventoryBatchId);
  }

  async getInventoryBatch(id: string) {
    return (
      (
        await this.db
          .select()
          .from(inventoryBatch)
          .where(eq(inventoryBatch.inventoryBatchId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── inventory_transaction_type_master ──────────────────────────────── */

  async createInventoryTransactionType(
    body: CreateInventoryTransactionType,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(inventoryTransactionTypeMaster)
          .values({
            typeCode: body.typeCode ?? null,
            typeName: body.typeName ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listInventoryTransactionTypes(
    query: ListQuery,
  ): Promise<Page<typeof inventoryTransactionTypeMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(inventoryTransactionTypeMaster)
      .where(
        query.cursor
          ? lt(inventoryTransactionTypeMaster.inventoryTransactionTypeId, query.cursor)
          : undefined,
      )
      .orderBy(desc(inventoryTransactionTypeMaster.inventoryTransactionTypeId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.inventoryTransactionTypeId);
  }

  async getInventoryTransactionType(id: string) {
    return (
      (
        await this.db
          .select()
          .from(inventoryTransactionTypeMaster)
          .where(eq(inventoryTransactionTypeMaster.inventoryTransactionTypeId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── FLOW: inventory_transaction (ISSUE/TRANSFER/ADJUSTMENT) + history ─ */

  async createInventoryTransaction(
    body: CreateInventoryTransaction,
    principal: AuthPrincipal,
  ) {
    return this.db.transaction(async (tx) => {
      const now = body.transactionDt ? new Date(body.transactionDt) : new Date();
      const inventoryTransactionId = uuidv7();

      const txn = ensure(
        (
          await tx
            .insert(inventoryTransaction)
            .values({
              inventoryTransactionId,
              inventoryBatchId: body.inventoryBatchId ?? null,
              inventoryTransactionTypeId: body.inventoryTransactionTypeId ?? null,
              transactionQty:
                body.transactionQty != null ? String(body.transactionQty) : null,
              uomId: body.uomId ?? null,
              fromLocationId: body.fromLocationId ?? null,
              toLocationId: body.toLocationId ?? null,
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
              inventoryBatchId: body.inventoryBatchId ?? null,
              eventType: body.eventType ?? 'TRANSACTION',
              eventDt: now,
              inventoryTransactionId,
              referenceDocumentId: body.referenceDocumentId ?? null,
              referenceDocumentType: body.referenceDocumentType ?? null,
              performedBy: principal.userId,
              remarks: body.remarks ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      // Ledger→balance (audit H-C2): the movement direction comes from the movement kind, not a
      // loose "not-OUT ⇒ add" test that silently inflated on-hand for TRANSFER/ADJUSTMENT/blank.
      //   TRANSFER  → net-zero (relocates stock; total on-hand unchanged — the move is applied elsewhere)
      //   ADJUSTMENT→ signed as-is (a correction may be + or −)
      //   ISSUE/CONSUME/PICK/DISPATCH/REMOVE/SCRAP/OUT → subtract |qty|
      //   RECEIVE/RETURN/IN (default) → add |qty|
      if (body.inventoryBatchId && body.transactionQty != null) {
        const et = (body.eventType ?? '').toUpperCase();
        const qty = Number(body.transactionQty);
        let delta: number;
        if (/TRANSFER/.test(et)) delta = 0;
        else if (/ADJUST/.test(et)) delta = qty;
        else if (/ISSUE|OUT|CONSUME|PICK|DISPATCH|REMOVE|SCRAP/.test(et)) delta = -Math.abs(qty);
        else delta = Math.abs(qty);
        if (delta !== 0) {
          await tx
            .update(inventoryBatch)
            .set({
              quantityOnHand: sql`coalesce(${inventoryBatch.quantityOnHand}, 0) + ${delta}`,
              updatedBy: principal.userId,
            })
            .where(eq(inventoryBatch.inventoryBatchId, body.inventoryBatchId));
        }
      }

      return { transaction: txn, history };
    });
  }

  async listInventoryTransactions(
    query: ListQuery,
  ): Promise<Page<typeof inventoryTransaction.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(inventoryTransaction)
      .where(
        query.cursor
          ? lt(inventoryTransaction.inventoryTransactionId, query.cursor)
          : undefined,
      )
      .orderBy(desc(inventoryTransaction.inventoryTransactionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.inventoryTransactionId);
  }

  async getInventoryTransaction(id: string) {
    return (
      (
        await this.db
          .select()
          .from(inventoryTransaction)
          .where(eq(inventoryTransaction.inventoryTransactionId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── inventory_event_history ────────────────────────────────────────── */

  async createInventoryEventHistory(
    body: CreateInventoryEventHistory,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(inventoryEventHistory)
          .values({
            inventoryBatchId: body.inventoryBatchId ?? null,
            eventType: body.eventType ?? null,
            eventDt: body.eventDt ? new Date(body.eventDt) : new Date(),
            inventoryTransactionId: body.inventoryTransactionId ?? null,
            referenceDocumentId: body.referenceDocumentId ?? null,
            referenceDocumentType: body.referenceDocumentType ?? null,
            performedBy: body.performedBy ?? principal.userId,
            remarks: body.remarks ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listInventoryEventHistories(
    query: ListQuery,
  ): Promise<Page<typeof inventoryEventHistory.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(inventoryEventHistory)
      .where(
        query.cursor
          ? lt(inventoryEventHistory.inventoryEventHistoryId, query.cursor)
          : undefined,
      )
      .orderBy(desc(inventoryEventHistory.inventoryEventHistoryId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.inventoryEventHistoryId);
  }

  async getInventoryEventHistory(id: string) {
    return (
      (
        await this.db
          .select()
          .from(inventoryEventHistory)
          .where(eq(inventoryEventHistory.inventoryEventHistoryId, id))
          .limit(1)
      )[0] ?? null
    );
  }
}
