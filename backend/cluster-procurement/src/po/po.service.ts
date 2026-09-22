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
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
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
  PurchaseOrderItemInput,
} from '../cluster-procurement.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const {
  purchaseOrder,
  purchaseOrderItems,
  poApprovalOrder,
  vendorPoAck,
  outbox,
  quotations,
  quotationItems,
  rfqVendorMappings,
} = procurementSchema;

// RP-FAC2 (§28 approval-threshold follow-up): a PO above this amount needs a SECOND, distinct
// approval before it is truly APPROVED — a single approver's sign-off only moves it to
// PENDING_L2_APPROVAL. Below the threshold, one approval is enough (unchanged behaviour). The
// figure itself is a system default pending an owner-configured per-tenant threshold table (not
// yet modelled) — kept as one named constant so it's a single edit away from being data-driven.
const PO_APPROVAL_THRESHOLD_AMOUNT = 500000;

@Injectable()
export class PoService {
  constructor(@Inject(PROCUREMENT_DB) private readonly db: ProcurementDb) {}

  /* ── purchase_order — create from a quotation, total = Σ(amount) ─────── */

  /**
   * POST /v1/purchase-orders. When `quotationId` is supplied, this now enforces the formal
   * "select winning quotation" step that used to be missing from the RFQ → PO flow (RP-PROC-006):
   *   - the quotation must exist
   *   - if `vendorId` is also supplied, it must match the quotation's own vendor (vendor
   *     mismatch is refused — a PO cannot be raised in vendor A's name off vendor B's quote)
   *   - the quotation's vendor must actually be a mapped/invited vendor on the quotation's RFQ
   *     ("vendorId actually submitted quotationId for that RFQ")
   *   - the quotation must hold status 'SELECTED' (awarded via POST /v1/quotations/:id/select) —
   *     an unselected quotation, or a losing one from an RFQ that already awarded a DIFFERENT
   *     quotation (double award), is refused
   * On success the PO's vendorId, lines, quantities and prices are BOUND from the quotation's own
   * quotation_items — client-supplied `items`/`vendorId` are ignored for a quotation-backed PO, so
   * a caller cannot raise a PO at different prices/lines than what actually won the RFQ.
   * With no `quotationId` (e.g. an emergency/direct purchase with no RFQ), behaviour is unchanged:
   * items + vendorId come straight from the body.
   */
  async createPurchaseOrder(body: CreatePurchaseOrder, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      let items: PurchaseOrderItemInput[] = body.items;
      let vendorId = body.vendorId ?? null;

      if (body.quotationId) {
        const quotationId = body.quotationId;
        // Security review R1 #2: lock the quotation row FIRST. Without this, two concurrent
        // createPurchaseOrder calls off the SAME already-SELECTED quotation could both pass every
        // check below before either had inserted its purchase_order row — two POs backed by one
        // quotation. The lock serializes the second call behind the first; combined with the
        // existing-PO check further down (run under this same lock), the second call always sees
        // the first's already-committed purchase_order row and is refused.
        const quotation = (
          await tx.select().from(quotations).where(eq(quotations.quotationId, quotationId)).for('update').limit(1)
        )[0];
        if (!quotation) throw new NotFoundException(`quotation not found: ${quotationId}`);

        if (body.vendorId && quotation.vendorId && body.vendorId !== quotation.vendorId) {
          throw new ForbiddenException(
            `Vendor mismatch: quotation ${quotationId} was submitted by vendor ${quotation.vendorId}, not ${body.vendorId} — a purchase order cannot be raised against another vendor's quotation.`,
          );
        }
        vendorId = quotation.vendorId ?? vendorId;

        if (quotation.rfqId && quotation.vendorId) {
          const mapped = (
            await tx
              .select()
              .from(rfqVendorMappings)
              .where(
                and(
                  eq(rfqVendorMappings.rfqId, quotation.rfqId),
                  eq(rfqVendorMappings.vendorId, quotation.vendorId),
                ),
              )
              .limit(1)
          )[0];
          if (!mapped) {
            throw new ForbiddenException(
              `Vendor ${quotation.vendorId} was never invited/mapped to RFQ ${quotation.rfqId} — its quotation cannot back a purchase order.`,
            );
          }
        }

        const status = String(quotation.status ?? '').toUpperCase();
        if (status !== 'SELECTED') {
          throw new ConflictException(
            `Quotation ${quotationId} has not been selected as the RFQ's winning quotation (status: ${quotation.status ?? '(none)'}). Award it first via POST /v1/quotations/${quotationId}/select.`,
          );
        }

        // One PO per quotation. Run under the row lock taken above so a second concurrent call
        // off the same quotation always sees the first's already-committed purchase_order row.
        const existingPo = (
          await tx
            .select({ purchaseOrderId: purchaseOrder.purchaseOrderId })
            .from(purchaseOrder)
            .where(eq(purchaseOrder.quotationId, quotationId))
            .limit(1)
        )[0];
        if (existingPo) {
          throw new ConflictException(
            `Quotation ${quotationId} already backs purchase order ${existingPo.purchaseOrderId}; a quotation can back only one purchase order.`,
          );
        }

        const qItems = await tx
          .select()
          .from(quotationItems)
          .where(eq(quotationItems.quotationId, quotationId));
        if (qItems.length === 0) {
          throw new ConflictException(`Quotation ${quotationId} has no line items to bind to a purchase order.`);
        }
        items = qItems.map((qi) => ({
          materialId: qi.materialId,
          orderedQty: qi.quotedQty,
          uomId: qi.uomId,
          rate: qi.quotedRate,
          amount:
            qi.quotedQty != null && qi.quotedRate != null
              ? Number(qi.quotedQty) * Number(qi.quotedRate)
              : null,
        }));
      }

      // Line amount = explicit amount, else qty × rate; never NaN (PROC-19: the total previously
      // did raw Number(it.amount) which is NaN when the form only sends qty + rate, corrupting
      // total_amount on every UI-created PO).
      const lineAmount = (it: PurchaseOrderItemInput): number => {
        const amt = it.amount != null ? Number(it.amount) : Number(it.orderedQty ?? 0) * Number(it.rate ?? 0);
        return Number.isFinite(amt) ? amt : 0;
      };
      const total = items.reduce((sum, it) => sum + lineAmount(it), 0);

      const poId = uuidv7();
      const po = ensure(
        (
          await tx
            .insert(purchaseOrder)
            .values({
              purchaseOrderId: poId,
              poNumber: (body.poNumber && String(body.poNumber).trim()) || ('PO-' + new Date().toISOString().slice(0, 7).replace('-', '') + '-' + String(Date.now()).slice(-5)),
              vendorId: vendorId ?? null,
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

      const insertedItems: (typeof purchaseOrderItems.$inferSelect)[] = [];
      for (const it of items) {
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
        insertedItems.push(row);
      }

      return { purchaseOrder: po, items: insertedItems };
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

  /* ── FLOW: PO approve → APPROVED (+ approval-threshold second level) ─── */

  /**
   * POST /v1/purchase-orders/:id/approve. Below PO_APPROVAL_THRESHOLD_AMOUNT, one approval is
   * enough: DRAFT/PENDING → APPROVED. At or above it, the FIRST approval only reaches
   * PENDING_L2_APPROVAL; a SECOND approval — by someone other than the creator AND other than the
   * first approver — is required to actually reach APPROVED. Both the PO row update and the
   * status pre-check run as a compare-and-swap (`WHERE status = :current`) so two concurrent
   * approve calls can't both register.
   */
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

      const current = String(po.status ?? '').toUpperCase();
      // State-machine guard (audit G/#3): only a DRAFT/PENDING/PENDING_L2_APPROVAL PO can be
      // approved — a direct API call must not re-approve or approve out of order.
      if (!['DRAFT', 'PENDING', 'PENDING_APPROVAL', 'PENDING_L2_APPROVAL'].includes(current)) {
        throw new ConflictException(`Purchase order cannot be approved from status ${current || '(none)'} (must be DRAFT/PENDING/PENDING_L2_APPROVAL).`);
      }

      // Segregation of duties (owner's approval matrix + system rule): the user who CREATED a PO
      // cannot approve it — even if they temporarily hold the approver role. The document stays
      // pending, rerouted to the next eligible approver (any other holder of the approve perm).
      if (po.createdBy && po.createdBy === principal.userId) {
        throw new ForbiddenException(
          'Segregation of duties: you created this purchase order, so you cannot approve it. It remains pending for another authorized approver (Procurement Head).',
        );
      }

      const overThreshold = Number(po.totalAmount ?? 0) >= PO_APPROVAL_THRESHOLD_AMOUNT;
      const needsSecondLevel = overThreshold && current !== 'PENDING_L2_APPROVAL';

      if (current === 'PENDING_L2_APPROVAL') {
        // Second-level approver must differ from whoever registered the first approval.
        const firstApprover = (
          await tx
            .select({ approverUserId: poApprovalOrder.approverUserId })
            .from(poApprovalOrder)
            .where(eq(poApprovalOrder.purchaseOrderId, id))
            .orderBy(desc(poApprovalOrder.poApprovalOrderId))
            .limit(1)
        )[0];
        if (firstApprover?.approverUserId && firstApprover.approverUserId === principal.userId) {
          throw new ForbiddenException(
            'Segregation of duties: a purchase order over the approval threshold needs a SECOND, different approver — you already gave the first approval.',
          );
        }
      }

      const now = new Date();
      const targetStatus = needsSecondLevel ? 'PENDING_L2_APPROVAL' : 'APPROVED';

      const approval = ensure(
        (
          await tx
            .insert(poApprovalOrder)
            .values({
              poApprovalOrderId: uuidv7(),
              purchaseOrderId: id,
              // Security review R1 #1: approver identity is ALWAYS the authenticated principal,
              // never client-suppliable — approvePurchaseOrder no longer accepts approverUserId.
              approverUserId: principal.userId,
              approvalLevel: needsSecondLevel ? 1 : current === 'PENDING_L2_APPROVAL' ? 2 : 1,
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
            .set({ status: targetStatus, updatedBy: principal.userId })
            .where(and(eq(purchaseOrder.purchaseOrderId, id), eq(purchaseOrder.status, current)))
            .returning()
        )[0],
      );
      if (!updated) {
        throw new ConflictException(`Purchase order ${id} was moved off ${current} by a concurrent request; refusing this stale approval.`);
      }

      return { purchaseOrder: updated, approval, requiresSecondLevelApproval: needsSecondLevel };
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

      // State-machine guard (audit G/#3): a PO must be APPROVED before it can be ISSUED — this is
      // the exact gap where a direct API call could issue an unapproved order.
      {
        const st = String(po.status ?? '').toUpperCase();
        if (st !== 'APPROVED') {
          throw new ConflictException(`Purchase order must be APPROVED before it can be issued (current: ${st || '(none)'}).`);
        }
      }

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

      // State-machine guard (audit G/#3): only an ISSUED PO can be acknowledged by the vendor.
      {
        const st = String(po.status ?? '').toUpperCase();
        if (st !== 'ISSUED') {
          throw new ConflictException(`Purchase order must be ISSUED before it can be acknowledged (current: ${st || '(none)'}).`);
        }
      }

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
