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
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { productionEvents } from '../production.events.js';
import { paginate, type Page } from '../_helpers.js';
import type { CreateIssue, GeneratePickList, ListQuery } from '../production.dtos.js';

const {
  productionOrderIngredients,
  materialPickList,
  materialPickListItems,
  materialIssue,
  materialIssueItem,
  outbox,
} = productionSchema;

@Injectable()
export class PickingService {
  constructor(@Inject(PRODUCTION_DB) private readonly db: ProductionDb) {}

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

      return { pickList, itemCount: ingredients.length };
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
