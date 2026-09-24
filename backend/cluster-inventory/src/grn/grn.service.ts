/**
 * GrnService — GRN receiving over GRN_MASTER, GRN_ITEMS, GRN_CONTAINER plus the receiving
 * flow. createGrn builds the master + each line + its containers, AND for every line spawns
 * an rm_batch_master (batch_number = "RMB-"+short uuid) + batch_container_mappings — all in
 * one transaction. Emits one `inventory.grn.created` and one `inventory.batch.created` per
 * batch. numeric → String(n); date columns kept as ISO strings.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
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
/** Auto-assigned RM batch number suffix. Golden journey lane/j2: this was the FIRST 8 hex of a
 *  uuidv7 — which are the top 32 bits of the millisecond TIMESTAMP, identical for ~65 s — so a
 *  second GRN inside that window collided on `rm_batch_master_number_uq` and the receipt failed
 *  with a 500. The suffix now comes from the uuid's RANDOM tail (last 12 hex = 48 random bits). */
export function shortId(): string {
  return uuidv7().replace(/-/g, '').slice(-12).toUpperCase();
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
              // RECV-05: a GRN means goods were received — use the canonical vocabulary
              // (RECEIVED / PENDING / CANCELLED) that the edit dropdown now offers.
              status: 'RECEIVED',
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

        // Step 18 — Quantity Verification. Pull the ordered qty from the linked PO line, then
        // classify the receipt: MATCHED when received == ordered (and nothing damaged), else
        // SHORT / EXCESS; DAMAGED overrides a match. accepted defaults to received − damaged −
        // rejected. A mismatch (or damage) records a vendor notification below.
        let orderedQty: number | null = null;
        if (it.purchaseOrderItemId) {
          const poi = (await tx.execute(
            sql`select ordered_qty from procurement.purchase_order_items where purchase_order_item_id = ${it.purchaseOrderItemId} limit 1`,
          )) as unknown as Array<{ ordered_qty: string | null }>;
          orderedQty = poi[0]?.ordered_qty != null ? Number(poi[0].ordered_qty) : null;
        }
        const received = it.receivedQty != null ? Number(it.receivedQty) : 0;
        const damaged = it.damagedQty != null ? Number(it.damagedQty) : 0;
        const rejected = it.rejectedQty != null ? Number(it.rejectedQty) : damaged;
        const accepted = it.acceptedQty != null ? Number(it.acceptedQty) : Math.max(0, received - damaged - (it.rejectedQty != null ? rejected : 0));
        let varianceQty: number | null = null;
        let varianceType = 'MATCHED';
        if (orderedQty != null) {
          varianceQty = Number((received - orderedQty).toFixed(3));
          if (Math.abs(varianceQty) > 0.0001) varianceType = received < orderedQty ? 'SHORT' : 'EXCESS';
        }
        if (damaged > 0 && varianceType === 'MATCHED') varianceType = 'DAMAGED';

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
                acceptedQty: String(accepted),
                rejectedQty: String(rejected),
                orderedQty: orderedQty != null ? String(orderedQty) : null,
                damagedQty: String(damaged),
                varianceQty: varianceQty != null ? String(varianceQty) : null,
                varianceType,
                varianceReason: it.varianceReason ?? null,
                status: 'ACTIVE',
                createdBy: principal.userId,
                updatedBy: principal.userId,
              })
              .returning()
          )[0],
        );
        items.push(item);

        // Vendor notification on any short/excess/damaged receipt (scope-freeze step 18 branch).
        if (varianceType !== 'MATCHED') {
          try {
            await tx.execute(sql`
              insert into platform.notification_log (notification_log_id, event_id, event_type, channel, recipient, subject, body, status, created_dt)
              values (gen_random_uuid(), ${grnItemId}, 'grn.variance', 'EMAIL',
                      ${master.vendorId ? String(master.vendorId) : 'vendor'},
                      ${'GRN ' + master.grnNumber + ' — ' + varianceType + ' variance'},
                      ${'GRN ' + master.grnNumber + ': ordered ' + (orderedQty ?? '—') + ', received ' + received + (damaged ? ', damaged ' + damaged : '') + ' → ' + varianceType + (it.varianceReason ? ' (' + it.varianceReason + ')' : '') + '. Please review with purchase.'},
                      'LOGGED', now())`);
          } catch {
            /* best-effort: a notification failure must not roll back the receipt */
          }
        }

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

  async listGrnItems(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with the GRN number + the Step-18 quantity-verification fields so ordered-vs-received
    // and the variance classification are visible. material_id is kept (interceptor masks it for
    // non-reveal callers); no real material name is added here.
    const rows = (await this.db.execute(sql`
      select gi.grn_item_id as "grnItemId", gi.grn_id as "grnId", g.grn_number as "grnNumber",
             gi.material_id as "materialId", gi.uom_id as "uomId",
             gi.ordered_qty as "orderedQty", gi.received_qty as "receivedQty",
             gi.accepted_qty as "acceptedQty", gi.rejected_qty as "rejectedQty", gi.damaged_qty as "damagedQty",
             gi.variance_qty as "varianceQty", gi.variance_type as "varianceType", gi.variance_reason as "varianceReason",
             gi.status as "status"
        from inventory.grn_items gi
        left join inventory.grn_master g on g.grn_id = gi.grn_id
       ${query.cursor ? sql`where gi.grn_item_id < ${query.cursor}` : sql``}
       order by gi.grn_item_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.grnItemId as string);
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

  async listGrnContainers(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    const rows = (await this.db.execute(sql`
      select c.grn_container_id as "grnContainerId", c.grn_id as "grnId", g.grn_number as "grnNumber",
             c.grn_item_id as "grnItemId", c.container_code as "containerCode",
             c.container_qty as "containerQty", c.status as "status"
        from inventory.grn_container c
        left join inventory.grn_master g on g.grn_id = c.grn_id
       ${query.cursor ? sql`where c.grn_container_id < ${query.cursor}` : sql``}
       order by c.grn_container_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.grnContainerId as string);
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
