/**
 * PoService — CRUD over the PO tables (PURCHASE_ORDER, PURCHASE_ORDER_ITEMS,
 * PO_APPROVAL_ORDER, VENDOR_PO_ACK) PLUS the PO document flow.
 *
 * A purchase_order is a transactional document carrying a `status` lifecycle on the dict
 * `status` column: DRAFT → APPROVED → ISSUED → ACKNOWLEDGED. createPurchaseOrder builds the
 * header from a quotation + its lines and computes total_amount = Σ(amount) in one
 * transaction. approve/issue/acknowledge each run in a transaction and write the dict
 * approval/ack rows; issue also records a `procurement.po.issued` outbox event so downstream
 * inventory/GRN can cold-read the PO. numeric → String(n); dates → ISO date strings.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { recordOutbox } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import {
  PROCUREMENT_DB,
  procurementSchema,
  type ProcurementDb,
} from '../cluster-procurement.tokens.js';
import { poIssued } from '../cluster-procurement.events.js';
import type { Page, ListQuery } from '../cluster-procurement.dtos.js';
import type {
  AcknowledgePurchaseOrder,
  ApprovePurchaseOrder,
  CreatePoApprovalOrder,
  CreatePurchaseOrder,
  CreatePurchaseOrderItem,
  CreateVendorPoAck,
} from '../cluster-procurement.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const { purchaseOrder, purchaseOrderItems, poApprovalOrder, vendorPoAck, outbox } =
  procurementSchema;

@Injectable()
export class PoService {
  constructor(@Inject(PROCUREMENT_DB) private readonly db: ProcurementDb) {}

  /* ── purchase_order — create from a quotation, total = Σ(amount) ─────── */

  async createPurchaseOrder(body: CreatePurchaseOrder, principal: AuthPrincipal) {
    const total = body.items.reduce((sum, it) => sum + Number(it.amount), 0);

    return this.db.transaction(async (tx) => {
      const poId = uuidv7();
      const po = ensure(
        (
          await tx
            .insert(purchaseOrder)
            .values({
              purchaseOrderId: poId,
              poNumber: (body.poNumber && String(body.poNumber).trim()) || ('PO-' + new Date().toISOString().slice(0, 7).replace('-', '') + '-' + String(Date.now()).slice(-5)),
              vendorId: body.vendorId ?? null,
              quotationId: body.quotationId ?? null,
              purchaseRequestId: body.purchaseRequestId ?? null,
              orderDate: body.orderDate ?? null,
              deliveryLocationId: body.deliveryLocationId ?? null,
              currencyId: body.currencyId ?? null,
              totalAmount: String(total),
              status: 'DRAFT',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      const items: (typeof purchaseOrderItems.$inferSelect)[] = [];
      for (const it of body.items) {
        const row = ensure(
          (
            await tx
              .insert(purchaseOrderItems)
              .values({
                purchaseOrderItemId: uuidv7(),
                purchaseOrderId: poId,
                materialId: it.materialId ?? null,
                orderedQty: it.orderedQty != null ? String(it.orderedQty) : null,
                uomId: it.uomId ?? null,
                rate: it.rate != null ? String(it.rate) : null,
                amount: String(it.amount),
                status: 'ACTIVE',
                createdBy: principal.userId,
                updatedBy: principal.userId,
              })
              .returning()
          )[0],
        );
        items.push(row);
      }

      return { purchaseOrder: po, items };
    });
  }

  async listPurchaseOrders(
    query: ListQuery,
  ): Promise<Page<typeof purchaseOrder.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(purchaseOrder)
      .where(query.cursor ? lt(purchaseOrder.purchaseOrderId, query.cursor) : undefined)
      .orderBy(desc(purchaseOrder.purchaseOrderId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.purchaseOrderId);
  }

  async getPurchaseOrder(id: string) {
    return (
      (
        await this.db
          .select()
          .from(purchaseOrder)
          .where(eq(purchaseOrder.purchaseOrderId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── purchase_order_items ───────────────────────────────────────────── */

  async createPurchaseOrderItem(body: CreatePurchaseOrderItem, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(purchaseOrderItems)
          .values({
            purchaseOrderId: body.purchaseOrderId ?? null,
            materialId: body.materialId ?? null,
            orderedQty: body.orderedQty != null ? String(body.orderedQty) : null,
            uomId: body.uomId ?? null,
            rate: body.rate != null ? String(body.rate) : null,
            amount: body.amount != null ? String(body.amount) : null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listPurchaseOrderItems(
    query: ListQuery,
  ): Promise<Page<typeof purchaseOrderItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(purchaseOrderItems)
      .where(
        query.cursor ? lt(purchaseOrderItems.purchaseOrderItemId, query.cursor) : undefined,
      )
      .orderBy(desc(purchaseOrderItems.purchaseOrderItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.purchaseOrderItemId);
  }

  async getPurchaseOrderItem(id: string) {
    return (
      (
        await this.db
          .select()
          .from(purchaseOrderItems)
          .where(eq(purchaseOrderItems.purchaseOrderItemId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── po_approval_order ──────────────────────────────────────────────── */

  async createPoApprovalOrder(body: CreatePoApprovalOrder, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(poApprovalOrder)
          .values({
            purchaseOrderId: body.purchaseOrderId ?? null,
            approverUserId: body.approverUserId ?? null,
            approvalLevel: body.approvalLevel ?? null,
            approvalStatus: body.approvalStatus ?? 'PENDING',
            remarks: body.remarks ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listPoApprovalOrders(
    query: ListQuery,
  ): Promise<Page<typeof poApprovalOrder.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(poApprovalOrder)
      .where(
        query.cursor ? lt(poApprovalOrder.poApprovalOrderId, query.cursor) : undefined,
      )
      .orderBy(desc(poApprovalOrder.poApprovalOrderId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.poApprovalOrderId);
  }

  async getPoApprovalOrder(id: string) {
    return (
      (
        await this.db
          .select()
          .from(poApprovalOrder)
          .where(eq(poApprovalOrder.poApprovalOrderId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── vendor_po_ack ──────────────────────────────────────────────────── */

  async createVendorPoAck(body: CreateVendorPoAck, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(vendorPoAck)
          .values({
            purchaseOrderId: body.purchaseOrderId ?? null,
            vendorId: body.vendorId ?? null,
            acknowledgedDt: new Date(),
            acceptedDeliveryDate: body.acceptedDeliveryDate ?? null,
            remarks: body.remarks ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listVendorPoAcks(
    query: ListQuery,
  ): Promise<Page<typeof vendorPoAck.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(vendorPoAck)
      .where(query.cursor ? lt(vendorPoAck.vendorPoAckId, query.cursor) : undefined)
      .orderBy(desc(vendorPoAck.vendorPoAckId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.vendorPoAckId);
  }

  async getVendorPoAck(id: string) {
    return (
      (
        await this.db
          .select()
          .from(vendorPoAck)
          .where(eq(vendorPoAck.vendorPoAckId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── FLOW: PO approve → APPROVED + approval row APPROVED ─────────────── */

  async approvePurchaseOrder(
    id: string,
    body: ApprovePurchaseOrder,
    principal: AuthPrincipal,
  ) {
    return this.db.transaction(async (tx) => {
      const po = (
        await tx
          .select()
          .from(purchaseOrder)
          .where(eq(purchaseOrder.purchaseOrderId, id))
          .limit(1)
      )[0];
      if (!po) throw new Error(`purchase_order not found: ${id}`);

      const now = new Date();

      const approval = ensure(
        (
          await tx
            .insert(poApprovalOrder)
            .values({
              poApprovalOrderId: uuidv7(),
              purchaseOrderId: id,
              approverUserId: body.approverUserId ?? principal.userId,
              approvalLevel: body.approvalLevel ?? 1,
              approvalStatus: 'APPROVED',
              approvedDt: now,
              remarks: body.remarks ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      const updated = ensure(
        (
          await tx
            .update(purchaseOrder)
            .set({ status: 'APPROVED', updatedBy: principal.userId })
            .where(eq(purchaseOrder.purchaseOrderId, id))
            .returning()
        )[0],
      );

      return { purchaseOrder: updated, approval };
    });
  }

  /* ── FLOW: PO issue → ISSUED + emit procurement.po.issued ───────────── */

  async issuePurchaseOrder(id: string, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const po = (
        await tx
          .select()
          .from(purchaseOrder)
          .where(eq(purchaseOrder.purchaseOrderId, id))
          .limit(1)
      )[0];
      if (!po) throw new Error(`purchase_order not found: ${id}`);

      const updated = ensure(
        (
          await tx
            .update(purchaseOrder)
            .set({ status: 'ISSUED', updatedBy: principal.userId })
            .where(eq(purchaseOrder.purchaseOrderId, id))
            .returning()
        )[0],
      );

      await recordOutbox(
        tx,
        outbox,
        poIssued,
        { purchaseOrderId: id, vendorId: updated.vendorId },
        id,
      );

      return updated;
    });
  }

  /* ── FLOW: PO acknowledge → ACKNOWLEDGED + vendor_po_ack row ─────────── */

  async acknowledgePurchaseOrder(
    id: string,
    body: AcknowledgePurchaseOrder,
    principal: AuthPrincipal,
  ) {
    return this.db.transaction(async (tx) => {
      const po = (
        await tx
          .select()
          .from(purchaseOrder)
          .where(eq(purchaseOrder.purchaseOrderId, id))
          .limit(1)
      )[0];
      if (!po) throw new Error(`purchase_order not found: ${id}`);

      const ack = ensure(
        (
          await tx
            .insert(vendorPoAck)
            .values({
              vendorPoAckId: uuidv7(),
              purchaseOrderId: id,
              vendorId: po.vendorId,
              acknowledgedDt: new Date(),
              acceptedDeliveryDate: body.acceptedDeliveryDate ?? null,
              remarks: body.remarks ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      const updated = ensure(
        (
          await tx
            .update(purchaseOrder)
            .set({ status: 'ACKNOWLEDGED', updatedBy: principal.userId })
            .where(eq(purchaseOrder.purchaseOrderId, id))
            .returning()
        )[0],
      );

      return { purchaseOrder: updated, ack };
    });
  }
}
