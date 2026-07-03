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
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
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
    // Line amount = explicit amount, else qty × rate; never NaN (PROC-19: the total previously
    // did raw Number(it.amount) which is NaN when the form only sends qty + rate, corrupting
    // total_amount on every UI-created PO).
    const lineAmount = (it: (typeof body.items)[number]): number => {
      const amt = it.amount != null ? Number(it.amount) : Number(it.orderedQty ?? 0) * Number(it.rate ?? 0);
      return Number.isFinite(amt) ? amt : 0;
    };
    const total = body.items.reduce((sum, it) => sum + lineAmount(it), 0);

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
                amount: String(lineAmount(it)),
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

  async listPurchaseOrders(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with vendor code/name (PROC-22 — no more raw uuid) + the original PO number when
    // this is a replacement (FAIL-04 display). Vendor identity is not the formula, so it's safe.
    const rows = (await this.db.execute(sql`
      select po.purchase_order_id as "purchaseOrderId", po.po_number as "poNumber",
             po.vendor_id as "vendorId", v.vendor_code as "vendorCode", v.vendor_name as "vendorName",
             po.quotation_id as "quotationId", po.purchase_request_id as "purchaseRequestId",
             po.order_date as "orderDate", po.total_amount as "totalAmount",
             po.replacement_of_po_id as "replacementOfPoId", op.po_number as "replacementOfPo",
             po.created_by as "createdBy", po.status as "status"
        from procurement.purchase_order po
        left join procurement.vendor_details v on v.vendor_id = po.vendor_id
        left join procurement.purchase_order op on op.purchase_order_id = po.replacement_of_po_id
       ${query.cursor ? sql`where po.purchase_order_id < ${query.cursor}` : sql``}
       order by po.purchase_order_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.purchaseOrderId as string);
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

  async listPurchaseOrderItems(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with PO number + material + ordered qty, and a composite `label` so the GRN
    // quantity-verification form can pick the exact PO line being received. Readers (Owner/
    // Procurement/Receiving) hold material reveal.
    const rows = (await this.db.execute(sql`
      select poi.purchase_order_item_id as "purchaseOrderItemId", poi.purchase_order_id as "purchaseOrderId",
             po.po_number as "poNumber", poi.material_id as "materialId", m.material_name as "materialName",
             poi.ordered_qty as "orderedQty", poi.rate as "rate", poi.uom_id as "uomId", poi.status as "status",
             coalesce(po.po_number, '') || ' · ' || coalesce(m.material_name, m.material_code, '?') || ' · ord ' || coalesce(poi.ordered_qty::text, '0') as "label"
        from procurement.purchase_order_items poi
        left join procurement.purchase_order po on po.purchase_order_id = poi.purchase_order_id
        left join masterdata.material m on m.material_id = poi.material_id
       ${query.cursor ? sql`where poi.purchase_order_item_id < ${query.cursor}` : sql``}
       order by poi.purchase_order_item_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.purchaseOrderItemId as string);
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

      // Segregation of duties (owner's approval matrix + system rule): the user who CREATED a PO
      // cannot approve it — even if they temporarily hold the approver role. The document stays
      // pending, rerouted to the next eligible approver (any other holder of the approve perm).
      if (po.createdBy && po.createdBy === principal.userId) {
        throw new ForbiddenException(
          'Segregation of duties: you created this purchase order, so you cannot approve it. It remains pending for another authorized approver (Procurement Head).',
        );
      }

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
