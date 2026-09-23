/**
 * PickingService — material picking + issue: MATERIAL_PICK_LIST, MATERIAL_PICK_LIST_ITEMS,
 * MATERIAL_ISSUE, MATERIAL_ISSUE_ITEM. CRUD reads for all four, plus two flows:
 *
 *   generatePickList → reads the order's production_order_ingredients and, in one tx, inserts
 *                      a material_pick_list + one material_pick_list_items per ingredient
 *                      (picked_qty = the ingredient.required_qty).
 *   issueMaterials   → in one tx inserts a material_issue + one material_issue_item per item
 *                      (issued_qty = true boolean), flips production_order_ingredients.issued_qty
 *                      to true for each issued material, and emits production.materials.issued.
 *
 * issued_qty is BOOLEAN per the locked dictionary. Pre-generated ids use uuidv7();
 * created_by/updated_by = principal.userId; numerics via num(); ISO timestamps → Date.
 * material/inventory/uom/order/pick-list refs are id-only soft refs (plain uuid, no FK here).
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { FORMULA_LOOKUP, type CodedInstruction, type FormulaLookup } from '@ra/cluster-formula';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { productionEvents } from '../production.events.js';
import { paginate, type Page } from '../_helpers.js';
import type { CreateIssue, GeneratePickList, ListQuery } from '../production.dtos.js';

const {
  productionOrder,
  productionOrderIngredients,
  materialPickList,
  materialPickListItems,
  materialIssue,
  materialIssueItem,
  outbox,
} = productionSchema;

/** Order statuses that may resolve a manufacturing instruction (security review item 4) — a
 * still-PLANNING order (never released to the floor for picking) has no business exposing
 * resolved batch quantities yet. Kept as an ALLOW-list (not "anything but PLANNING") so an
 * unanticipated future status (e.g. CANCELLED, ON_HOLD) fails closed by default rather than
 * silently being treated as active. */
const ACTIVE_ORDER_STATUSES = new Set(['INPROGRESS']);

@Injectable()
export class PickingService {
  constructor(
    @Inject(PRODUCTION_DB) private readonly db: ProductionDb,
    @Inject(FORMULA_LOOKUP) private readonly formula: FormulaLookup,
  ) {}

  /* ── material pick list (CRUD reads) ─────────────────────────────── */

  async listPickLists(query: ListQuery): Promise<Page<typeof materialPickList.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialPickList)
      .where(query.cursor ? lt(materialPickList.materialPickListId, query.cursor) : undefined)
      .orderBy(desc(materialPickList.materialPickListId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialPickListId);
  }

  async getPickList(id: string) {
    return (
      await this.db
        .select()
        .from(materialPickList)
        .where(eq(materialPickList.materialPickListId, id))
        .limit(1)
    )[0] ?? null;
  }

  async listPickListItems(
    query: ListQuery,
  ): Promise<Page<typeof materialPickListItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialPickListItems)
      .where(
        query.cursor
          ? lt(materialPickListItems.materialPickListItemId, query.cursor)
          : undefined,
      )
      .orderBy(desc(materialPickListItems.materialPickListItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialPickListItemId);
  }

  async getPickListItem(id: string) {
    return (
      await this.db
        .select()
        .from(materialPickListItems)
        .where(eq(materialPickListItems.materialPickListItemId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── flow: generate pick list ────────────────────────────────────── */

  /**
   * POST /v1/production-orders/:id/pick-list — expand the order's ingredients into a pick list.
   * One material_pick_list header + one material_pick_list_items per ingredient
   * (picked_qty = ingredient.required_qty).
   */
  async generatePickList(orderId: string, body: GeneratePickList, principal: AuthPrincipal) {
    const ingredients = await this.db
      .select()
      .from(productionOrderIngredients)
      .where(eq(productionOrderIngredients.productionOrderId, orderId));
    if (ingredients.length === 0) {
      throw new NotFoundException(`no ingredients for production_order: ${orderId}`);
    }

    return this.db.transaction(async (tx) => {
      const pickList = (
        await tx
          .insert(materialPickList)
          .values({
            materialPickListId: uuidv7(),
            productionOrderId: orderId,
            pickListDate: body.pickListDate ?? null,
            generatedBy: principal.userId,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!pickList) throw new Error('insert failed: material_pick_list');

      const materialPickListId = pickList.materialPickListId;

      for (const ing of ingredients) {
        await tx.insert(materialPickListItems).values({
          materialPickListItemId: uuidv7(),
          materialPickListId,
          materialId: ing.materialId,
          pickedQty: ing.requiredQty,
          uomId: ing.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
      }

      // Advance the order so it moves past PLANNING (audit H-C5): a pick list has been drawn, the
      // order is now in progress. Only advances from PLANNING (not from a later state).
      await tx
        .update(productionOrder)
        .set({ status: 'INPROGRESS', updatedBy: principal.userId })
        .where(and(eq(productionOrder.productionOrderId, orderId), eq(productionOrder.status, 'PLANNING')));

      return { pickList, itemCount: ingredients.length };
    });
  }

  /**
   * GET /v1/production-orders/:id/manufacturing-instruction — §109.7
   * `VaultPort.resolveManufacturingInstruction(production_order, approved_formula_version,
   * permitted_batch_quantity)`. `permitted_batch_quantity` is the order's own `order_qty`
   * (the batch this order is authorized to produce) — never a caller-supplied number, so a
   * caller can't inflate the resolved quantities beyond what the order actually permits.
   * Returns null (→ empty body, not an error) if the order has no formula version linked
   * yet; throws (403, also audited) if that version exists but isn't approved/locked yet.
   *
   * Security review item 4: additionally refuses an order that isn't yet ACTIVE (released to
   * the floor — see ACTIVE_ORDER_STATUSES; a still-PLANNING order has no pick list and no
   * business exposing resolved quantities yet), and threads `orderId` into the mandatory
   * vault-decrypt audit row via `requestId` — the underlying `VaultService.decryptVersion`
   * audit only ever recorded the formula_version_id, not WHICH production order the
   * resolution was for; "who, order, time" all land on one row this way.
   */
  async resolveManufacturingInstruction(
    orderId: string,
    principal: AuthPrincipal,
  ): Promise<CodedInstruction[] | null> {
    const order = (
      await this.db
        .select({
          formulaVersionId: productionOrder.formulaVersionId,
          orderQty: productionOrder.orderQty,
          status: productionOrder.status,
        })
        .from(productionOrder)
        .where(eq(productionOrder.productionOrderId, orderId))
        .limit(1)
    )[0];
    if (!order) throw new NotFoundException(`production_order not found: ${orderId}`);
    if (!order.formulaVersionId) return null;
    if (!ACTIVE_ORDER_STATUSES.has(String(order.status ?? ''))) {
      throw new ForbiddenException(
        `production_order ${orderId} is not in an active/released state (status: ${order.status ?? 'unknown'}) — the manufacturing instruction is only resolvable once the order has been released to the floor`,
      );
    }

    const permittedBatchQuantity = Number(order.orderQty ?? 0);
    return this.formula.resolveManufacturingInstruction(order.formulaVersionId, permittedBatchQuantity, {
      actorId: principal.userId,
      requestId: `production_order:${orderId}`,
    });
  }

  /* ── material issue (CRUD reads) ─────────────────────────────────── */

  async listIssues(query: ListQuery): Promise<Page<typeof materialIssue.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialIssue)
      .where(query.cursor ? lt(materialIssue.materialIssueId, query.cursor) : undefined)
      .orderBy(desc(materialIssue.materialIssueId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialIssueId);
  }

  async getIssue(id: string) {
    return (
      await this.db
        .select()
        .from(materialIssue)
        .where(eq(materialIssue.materialIssueId, id))
        .limit(1)
    )[0] ?? null;
  }

  async listIssueItems(query: ListQuery): Promise<Page<typeof materialIssueItem.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialIssueItem)
      .where(query.cursor ? lt(materialIssueItem.materialIssueItemId, query.cursor) : undefined)
      .orderBy(desc(materialIssueItem.materialIssueItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialIssueItemId);
  }

  async getIssueItem(id: string) {
    return (
      await this.db
        .select()
        .from(materialIssueItem)
        .where(eq(materialIssueItem.materialIssueItemId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── flow: issue materials ───────────────────────────────────────── */

  /**
   * POST /v1/material-issues — issue picked materials against the order. Inserts a
   * material_issue + one material_issue_item per item (issued_qty = true), flips each issued
   * material's production_order_ingredients.issued_qty to true, and emits
   * production.materials.issued. All in one transaction.
   */
  async issueMaterials(body: CreateIssue, principal: AuthPrincipal) {
    // RP-PROD-004: refuse an issue with no pick list. Production cannot debit
    // inventory.inventory_batch itself (cluster boundary) — ConsumptionService (backend/api/src/
    // consumption) is the only thing that ever decrements on-hand, and it can only do that from
    // a material_pick_list_items.picked_qty line. No pick list means no quantity anywhere for it
    // to apply, so the issue would be recorded but never actually debited — and MixingService.
    // abortSession would still have something (issued_qty=true) to "reverse", crediting stock
    // that was never removed. Requiring the pick list up front closes that gap at the source
    // instead of leaving it to the async consumer / abort path to paper over.
    if (!body.materialPickListId) {
      throw new BadRequestException(
        'material issue requires materialPickListId: production cannot debit inventory ' +
          'synchronously, so the async consumer needs a pick-list line to know the quantity ' +
          'to take. Generate a pick list for this order first.',
      );
    }
    return this.db.transaction(async (tx) => {
      const issue = (
        await tx
          .insert(materialIssue)
          .values({
            materialIssueId: uuidv7(),
            productionOrderId: body.productionOrderId,
            materialPickListId: body.materialPickListId ?? null,
            issuedDt: body.issuedDt ? new Date(body.issuedDt) : new Date(),
            issuedBy: principal.userId,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!issue) throw new Error('insert failed: material_issue');

      const materialIssueId = issue.materialIssueId;

      for (const item of body.items) {
        await tx.insert(materialIssueItem).values({
          materialIssueItemId: uuidv7(),
          materialIssueId,
          materialId: item.materialId,
          inventoryBatchId: item.inventoryBatchId ?? null,
          issuedQty: true,
          uomId: item.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });

        await tx
          .update(productionOrderIngredients)
          .set({ issuedQty: true, updatedBy: principal.userId })
          .where(
            and(
              eq(productionOrderIngredients.productionOrderId, body.productionOrderId),
              eq(productionOrderIngredients.materialId, item.materialId),
            ),
          );
      }

      await recordOutbox(
        tx,
        outbox,
        productionEvents.materialsIssued,
        { productionOrderId: body.productionOrderId, materialIssueId },
        materialIssueId,
      );

      return { issue, itemCount: body.items.length };
    });
  }
}
