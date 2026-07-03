/**
 * RequirementService — CRUD over the requirement + purchase-request tables
 * (STOCK_REQUIREMENT, STOCK_REQ_ITEMS, PURCHASE_REQUEST, PURCHASE_REQUEST_ITEMS,
 * PURCHASE_REQUEST_APPROVAL) PLUS the PR approval flow.
 *
 * A purchase_request is a transactional document: it carries a `status` lifecycle
 * (DRAFT → SUBMITTED → APPROVED) on the dict `status` column. submit() and approve() run
 * in a db.transaction and write the purchase_request_approval row alongside the status
 * change. numeric → String(n); dates → new Date(iso). Soft refs are plain uuids.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import {
  PROCUREMENT_DB,
  procurementSchema,
  type ProcurementDb,
} from '../cluster-procurement.tokens.js';
import type { Page, ListQuery } from '../cluster-procurement.dtos.js';
import type {
  ApprovePurchaseRequest,
  CreatePurchaseRequest,
  CreatePurchaseRequestApproval,
  CreatePurchaseRequestItem,
  CreateStockReqItem,
  CreateStockRequirement,
  SubmitPurchaseRequest,
} from '../cluster-procurement.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const {
  stockRequirement,
  stockReqItems,
  purchaseRequest,
  purchaseRequestItems,
  purchaseRequestApproval,
} = procurementSchema;

@Injectable()
export class RequirementService {
  constructor(@Inject(PROCUREMENT_DB) private readonly db: ProcurementDb) {}

  /* ── stock_requirement ──────────────────────────────────────────────── */

  async createStockRequirement(body: CreateStockRequirement, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(stockRequirement)
          .values({
            locationId: body.locationId ?? null,
            materialId: body.materialId ?? null,
            requiredQty: body.requiredQty != null ? String(body.requiredQty) : null,
            uomId: body.uomId ?? null,
            requiredByDate: body.requiredByDate ?? null,
            requirementSource: body.requirementSource ?? null,
            priority: body.priority ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listStockRequirements(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with material code/name (PROC-02 — the stock-planning list showed a raw uuid).
    // Read by procurement (material reveal), so the name is not a masking concern; material_id is
    // still surfaced so the interceptor masks it for any non-reveal caller.
    const rows = (await this.db.execute(sql`
      select sr.stock_requirement_id as "stockRequirementId", sr.material_id as "materialId",
             m.material_code as "materialCode", m.material_name as "materialName",
             sr.required_qty as "requiredQty", sr.required_by_date as "requiredByDate",
             sr.priority as "priority", sr.requirement_source as "requirementSource", sr.status as "status"
        from procurement.stock_requirement sr
        left join masterdata.material m on m.material_id = sr.material_id
       ${query.cursor ? sql`where sr.stock_requirement_id < ${query.cursor}` : sql``}
       order by sr.stock_requirement_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.stockRequirementId as string);
  }

  async getStockRequirement(id: string) {
    return (
      (
        await this.db
          .select()
          .from(stockRequirement)
          .where(eq(stockRequirement.stockRequirementId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── stock_req_items ────────────────────────────────────────────────── */

  async createStockReqItem(body: CreateStockReqItem, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(stockReqItems)
          .values({
            stockRequirementId: body.stockRequirementId ?? null,
            materialId: body.materialId ?? null,
            requiredQty: body.requiredQty != null ? String(body.requiredQty) : null,
            uomId: body.uomId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listStockReqItems(
    query: ListQuery,
  ): Promise<Page<typeof stockReqItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(stockReqItems)
      .where(query.cursor ? lt(stockReqItems.stockReqItemId, query.cursor) : undefined)
      .orderBy(desc(stockReqItems.stockReqItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.stockReqItemId);
  }

  async getStockReqItem(id: string) {
    return (
      (
        await this.db
          .select()
          .from(stockReqItems)
          .where(eq(stockReqItems.stockReqItemId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── purchase_request ───────────────────────────────────────────────── */

  async createPurchaseRequest(body: CreatePurchaseRequest, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(purchaseRequest)
          .values({
            prNumber: (body.prNumber && String(body.prNumber).trim()) || ('PR-' + new Date().toISOString().slice(0, 7).replace('-', '') + '-' + String(Date.now()).slice(-5)),
            stockRequirementId: body.stockRequirementId ?? null,
            requestLocationId: body.requestLocationId ?? null,
            deliveryLocationId: body.deliveryLocationId ?? null,
            priority: body.priority ?? null,
            expectedDeliveryDate: body.expectedDeliveryDate ?? null,
            status: 'DRAFT',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listPurchaseRequests(
    query: ListQuery,
  ): Promise<Page<typeof purchaseRequest.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(purchaseRequest)
      .where(
        query.cursor ? lt(purchaseRequest.purchaseRequestId, query.cursor) : undefined,
      )
      .orderBy(desc(purchaseRequest.purchaseRequestId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.purchaseRequestId);
  }

  async getPurchaseRequest(id: string) {
    return (
      (
        await this.db
          .select()
          .from(purchaseRequest)
          .where(eq(purchaseRequest.purchaseRequestId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── purchase_request_items ─────────────────────────────────────────── */

  async createPurchaseRequestItem(
    body: CreatePurchaseRequestItem,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(purchaseRequestItems)
          .values({
            purchaseRequestId: body.purchaseRequestId ?? null,
            materialId: body.materialId ?? null,
            requiredQty: body.requiredQty != null ? String(body.requiredQty) : null,
            uomId: body.uomId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listPurchaseRequestItems(
    query: ListQuery,
  ): Promise<Page<typeof purchaseRequestItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(purchaseRequestItems)
      .where(
        query.cursor
          ? lt(purchaseRequestItems.purchaseRequestItemId, query.cursor)
          : undefined,
      )
      .orderBy(desc(purchaseRequestItems.purchaseRequestItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.purchaseRequestItemId);
  }

  async getPurchaseRequestItem(id: string) {
    return (
      (
        await this.db
          .select()
          .from(purchaseRequestItems)
          .where(eq(purchaseRequestItems.purchaseRequestItemId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── purchase_request_approval ──────────────────────────────────────── */

  async createPurchaseRequestApproval(
    body: CreatePurchaseRequestApproval,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(purchaseRequestApproval)
          .values({
            purchaseRequestId: body.purchaseRequestId ?? null,
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

  async listPurchaseRequestApprovals(
    query: ListQuery,
  ): Promise<Page<typeof purchaseRequestApproval.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(purchaseRequestApproval)
      .where(
        query.cursor
          ? lt(purchaseRequestApproval.purchaseRequestApprovalId, query.cursor)
          : undefined,
      )
      .orderBy(desc(purchaseRequestApproval.purchaseRequestApprovalId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.purchaseRequestApprovalId);
  }

  async getPurchaseRequestApproval(id: string) {
    return (
      (
        await this.db
          .select()
          .from(purchaseRequestApproval)
          .where(eq(purchaseRequestApproval.purchaseRequestApprovalId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── FLOW: PR submit → SUBMITTED + PENDING approval row ─────────────── */

  async submitPurchaseRequest(
    id: string,
    body: SubmitPurchaseRequest,
    principal: AuthPrincipal,
  ) {
    return this.db.transaction(async (tx) => {
      const pr = (
        await tx
          .select()
          .from(purchaseRequest)
          .where(eq(purchaseRequest.purchaseRequestId, id))
          .limit(1)
      )[0];
      if (!pr) throw new Error(`purchase_request not found: ${id}`);

      const updated = ensure(
        (
          await tx
            .update(purchaseRequest)
            .set({ status: 'SUBMITTED', updatedBy: principal.userId })
            .where(eq(purchaseRequest.purchaseRequestId, id))
            .returning()
        )[0],
      );

      const approval = ensure(
        (
          await tx
            .insert(purchaseRequestApproval)
            .values({
              purchaseRequestApprovalId: uuidv7(),
              purchaseRequestId: id,
              approverUserId: body.approverUserId ?? null,
              approvalLevel: body.approvalLevel ?? 1,
              approvalStatus: 'PENDING',
              remarks: body.remarks ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      return { purchaseRequest: updated, approval };
    });
  }

  /* ── FLOW: PR approve → APPROVED + approval row APPROVED ─────────────── */

  async approvePurchaseRequest(
    id: string,
    body: ApprovePurchaseRequest,
    principal: AuthPrincipal,
  ) {
    return this.db.transaction(async (tx) => {
      const pr = (
        await tx
          .select()
          .from(purchaseRequest)
          .where(eq(purchaseRequest.purchaseRequestId, id))
          .limit(1)
      )[0];
      if (!pr) throw new Error(`purchase_request not found: ${id}`);

      // Segregation of duties (owner's approval matrix): the creator of a PR cannot approve it,
      // even if they hold the approver role. It stays pending for the next eligible approver.
      if (pr.createdBy && pr.createdBy === principal.userId) {
        throw new ForbiddenException(
          'Segregation of duties: you created this purchase request, so you cannot approve it. It remains pending for another authorized approver (Purchase Manager).',
        );
      }

      const now = new Date();

      const updated = ensure(
        (
          await tx
            .update(purchaseRequest)
            .set({
              status: 'APPROVED',
              approvedBy: body.approverUserId ?? principal.userId,
              approvedDt: now,
              updatedBy: principal.userId,
            })
            .where(eq(purchaseRequest.purchaseRequestId, id))
            .returning()
        )[0],
      );

      const pending = (
        await tx
          .select()
          .from(purchaseRequestApproval)
          .where(eq(purchaseRequestApproval.purchaseRequestId, id))
          .orderBy(desc(purchaseRequestApproval.purchaseRequestApprovalId))
          .limit(1)
      )[0];

      let approval;
      if (pending) {
        approval = ensure(
          (
            await tx
              .update(purchaseRequestApproval)
              .set({
                approvalStatus: 'APPROVED',
                approverUserId: body.approverUserId ?? principal.userId,
                approvedDt: now,
                remarks: body.remarks ?? pending.remarks ?? null,
                updatedBy: principal.userId,
              })
              .where(
                eq(
                  purchaseRequestApproval.purchaseRequestApprovalId,
                  pending.purchaseRequestApprovalId,
                ),
              )
              .returning()
          )[0],
        );
      } else {
        approval = ensure(
          (
            await tx
              .insert(purchaseRequestApproval)
              .values({
                purchaseRequestApprovalId: uuidv7(),
                purchaseRequestId: id,
                approverUserId: body.approverUserId ?? principal.userId,
                approvalLevel: 1,
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
      }

      return { purchaseRequest: updated, approval };
    });
  }
}
