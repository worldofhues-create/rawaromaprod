/**
 * GrnService — GRN receiving over GRN_MASTER, GRN_ITEMS, GRN_CONTAINER plus the receiving
 * flow. createGrn builds the master + each line + its containers, AND for every line spawns
 * an rm_batch_master (batch_number = "RMB-"+short uuid) + batch_container_mappings — all in
 * one transaction. Emits one `inventory.grn.created` and one `inventory.batch.created` per
 * batch. numeric → String(n); date columns kept as ISO strings.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { recordOutbox } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import {
  INVENTORY_DB,
  inventorySchema,
  type InventoryDb,
} from '../cluster-inventory.tokens.js';
import { inventoryEvents } from '../cluster-inventory.events.js';
import type { Page, ListQuery } from '../cluster-inventory.dtos.js';
import type {
  CreateGrn,
  CreateGrnContainer,
  CreateGrnItem,
} from '../cluster-inventory.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const {
  grnMaster,
  grnItems,
  grnContainer,
  rmBatchMaster,
  batchContainerMappings,
  outbox,
} = inventorySchema;

/** Short, human-friendly batch suffix derived from a fresh uuid (first segment). */
function shortId(): string {
  return uuidv7().split('-')[0]!.toUpperCase();
}

@Injectable()
export class GrnService {
  constructor(@Inject(INVENTORY_DB) private readonly db: InventoryDb) {}

  /* ── FLOW: GRN receive → master + items + containers + RM batches ────── */

  async createGrn(body: CreateGrn, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const grnId = uuidv7();
      const master = ensure(
        (
          await tx
            .insert(grnMaster)
            .values({
              grnId,
              grnNumber: (body.grnNumber && String(body.grnNumber).trim()) || ('GRN-' + new Date().toISOString().slice(0, 7).replace('-', '') + '-' + String(Date.now()).slice(-5)),
              gateEntryId: body.gateEntryId ?? null,
              purchaseOrderId: body.purchaseOrderId ?? null,
              vendorId: body.vendorId ?? null,
              locationId: body.locationId ?? null,
              grnDate: body.grnDate ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      const items: (typeof grnItems.$inferSelect)[] = [];
      const containers: (typeof grnContainer.$inferSelect)[] = [];
      const batches: (typeof rmBatchMaster.$inferSelect)[] = [];
      const mappings: (typeof batchContainerMappings.$inferSelect)[] = [];

      for (const it of body.items) {
        const grnItemId = uuidv7();
        const item = ensure(
          (
            await tx
              .insert(grnItems)
              .values({
                grnItemId,
                grnId,
                purchaseOrderItemId: it.purchaseOrderItemId ?? null,
                materialId: it.materialId ?? null,
                receivedQty: it.receivedQty != null ? String(it.receivedQty) : null,
                uomId: it.uomId ?? null,
                acceptedQty: it.acceptedQty != null ? String(it.acceptedQty) : null,
                rejectedQty: it.rejectedQty != null ? String(it.rejectedQty) : null,
                status: 'ACTIVE',
                createdBy: principal.userId,
                updatedBy: principal.userId,
              })
              .returning()
          )[0],
        );
        items.push(item);

        const lineContainers: (typeof grnContainer.$inferSelect)[] = [];
        for (const c of it.containers) {
          const container = ensure(
            (
              await tx
                .insert(grnContainer)
                .values({
                  grnContainerId: uuidv7(),
                  grnId,
                  grnItemId,
                  containerCode: c.containerCode ?? null,
                  containerQty: c.containerQty != null ? String(c.containerQty) : null,
                  uomId: c.uomId ?? null,
                  status: 'ACTIVE',
                  createdBy: principal.userId,
                  updatedBy: principal.userId,
                })
                .returning()
            )[0],
          );
          containers.push(container);
          lineContainers.push(container);
        }

        const rmBatchId = uuidv7();
        const batch = ensure(
          (
            await tx
              .insert(rmBatchMaster)
              .values({
                rmBatchId,
                grnItemId,
                materialId: it.materialId ?? null,
                batchNumber: `RMB-${shortId()}`,
                manufacturingDate: it.manufacturingDate ?? null,
                expiryDate: it.expiryDate ?? null,
                receivedQty: it.receivedQty != null ? String(it.receivedQty) : null,
                uomId: it.uomId ?? null,
                storageLocationId: it.storageLocationId ?? null,
                status: 'ACTIVE',
                createdBy: principal.userId,
                updatedBy: principal.userId,
              })
              .returning()
          )[0],
        );
        batches.push(batch);

        for (const container of lineContainers) {
          const mapping = ensure(
            (
              await tx
                .insert(batchContainerMappings)
                .values({
                  batchContainerMappingId: uuidv7(),
                  rmBatchId,
                  grnContainerId: container.grnContainerId,
                  status: 'ACTIVE',
                  createdBy: principal.userId,
                  updatedBy: principal.userId,
                })
                .returning()
            )[0],
          );
          mappings.push(mapping);
        }

        await recordOutbox(
          tx,
          outbox,
          inventoryEvents.batchCreated,
          { rmBatchId, materialId: it.materialId ?? null },
          rmBatchId,
        );
      }

      await recordOutbox(
        tx,
        outbox,
        inventoryEvents.grnCreated,
        { grnId, purchaseOrderId: body.purchaseOrderId ?? null },
        grnId,
      );

      return { grn: master, items, containers, batches, mappings };
    });
  }

  async listGrns(query: ListQuery): Promise<Page<typeof grnMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(grnMaster)
      .where(query.cursor ? lt(grnMaster.grnId, query.cursor) : undefined)
      .orderBy(desc(grnMaster.grnId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.grnId);
  }

  async getGrn(id: string) {
    return (
      (await this.db.select().from(grnMaster).where(eq(grnMaster.grnId, id)).limit(1))[0] ??
      null
    );
  }

  /* ── grn_items ──────────────────────────────────────────────────────── */

  async createGrnItem(body: CreateGrnItem, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(grnItems)
          .values({
            grnId: body.grnId ?? null,
            purchaseOrderItemId: body.purchaseOrderItemId ?? null,
            materialId: body.materialId ?? null,
            receivedQty: body.receivedQty != null ? String(body.receivedQty) : null,
            uomId: body.uomId ?? null,
            acceptedQty: body.acceptedQty != null ? String(body.acceptedQty) : null,
            rejectedQty: body.rejectedQty != null ? String(body.rejectedQty) : null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listGrnItems(query: ListQuery): Promise<Page<typeof grnItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(grnItems)
      .where(query.cursor ? lt(grnItems.grnItemId, query.cursor) : undefined)
      .orderBy(desc(grnItems.grnItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.grnItemId);
  }

  async getGrnItem(id: string) {
    return (
      (await this.db.select().from(grnItems).where(eq(grnItems.grnItemId, id)).limit(1))[0] ??
      null
    );
  }

  /* ── grn_container ──────────────────────────────────────────────────── */

  async createGrnContainer(body: CreateGrnContainer, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(grnContainer)
          .values({
            grnId: body.grnId ?? null,
            grnItemId: body.grnItemId ?? null,
            containerCode: body.containerCode ?? null,
            containerQty: body.containerQty != null ? String(body.containerQty) : null,
            uomId: body.uomId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listGrnContainers(
    query: ListQuery,
  ): Promise<Page<typeof grnContainer.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(grnContainer)
      .where(query.cursor ? lt(grnContainer.grnContainerId, query.cursor) : undefined)
      .orderBy(desc(grnContainer.grnContainerId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.grnContainerId);
  }

  async getGrnContainer(id: string) {
    return (
      (
        await this.db
          .select()
          .from(grnContainer)
          .where(eq(grnContainer.grnContainerId, id))
          .limit(1)
      )[0] ?? null
    );
  }
}
