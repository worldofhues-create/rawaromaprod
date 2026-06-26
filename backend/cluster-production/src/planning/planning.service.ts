/**
 * PlanningService — production planning masters + the order vault integration:
 * PRODUCTION_PLAN, PRODUCTION_PLAN_ITEMS, PRODUCTION_ORDER, PRODUCTION_ORDER_INGREDIENTS.
 * CRUD (create + list + get) for the three header/line masters, plus the KEY flow:
 *
 *   createOrder → reads the APPROVED formula's real pick list via FORMULA_LOOKUP.getPickList
 *                 (server-side only — the floor never sees the recipe), inserts the
 *                 production_order, expands one production_order_ingredients row per pick
 *                 (required_qty = order_qty * percentage / 100), and emits
 *                 `production.order.created` in the SAME transaction. If the formula version
 *                 is not approved/locked getPickList returns null → ForbiddenException.
 *
 * production_order_ingredients are NEVER created directly — they are expanded here.
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; numerics
 * stringified via num(); ISO timestamps → Date. formula/location/uom/material refs are
 * id-only soft refs (plain uuid, no FK at this layer).
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { FORMULA_LOOKUP, type FormulaLookup } from '@ra/cluster-formula';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { productionEvents } from '../production.events.js';
import { paginate, num, type Page } from '../_helpers.js';
import type {
  CreateOrder,
  CreatePlan,
  CreatePlanItem,
  ListQuery,
} from '../production.dtos.js';

const {
  productionPlan,
  productionPlanItems,
  productionOrder,
  productionOrderIngredients,
  outbox,
} = productionSchema;

@Injectable()
export class PlanningService {
  constructor(
    @Inject(PRODUCTION_DB) private readonly db: ProductionDb,
    @Inject(FORMULA_LOOKUP) private readonly formula: FormulaLookup,
  ) {}

  /* ── production plan ──────────────────────────────────────────────── */

  async createPlan(body: CreatePlan, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(productionPlan)
        .values({
          productionPlanId: uuidv7(),
          locationId: body.locationId ?? null,
          planDate: body.planDate ?? null,
          plannedStartDt: body.plannedStartDt ? new Date(body.plannedStartDt) : null,
          plannedEndDt: body.plannedEndDt ? new Date(body.plannedEndDt) : null,
          status: 'DRAFT',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: production_plan');
    return row;
  }

  async listPlans(query: ListQuery): Promise<Page<typeof productionPlan.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(productionPlan)
      .where(query.cursor ? lt(productionPlan.productionPlanId, query.cursor) : undefined)
      .orderBy(desc(productionPlan.productionPlanId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.productionPlanId);
  }

  async getPlan(id: string) {
    return (
      await this.db
        .select()
        .from(productionPlan)
        .where(eq(productionPlan.productionPlanId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── production plan items ────────────────────────────────────────── */

  async createPlanItem(body: CreatePlanItem, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(productionPlanItems)
        .values({
          productionPlanItemId: uuidv7(),
          productionPlanId: body.productionPlanId,
          formulaId: body.formulaId ?? null,
          plannedQty: num(body.plannedQty),
          uomId: body.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: production_plan_items');
    return row;
  }

  async listPlanItems(query: ListQuery): Promise<Page<typeof productionPlanItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(productionPlanItems)
      .where(query.cursor ? lt(productionPlanItems.productionPlanItemId, query.cursor) : undefined)
      .orderBy(desc(productionPlanItems.productionPlanItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.productionPlanItemId);
  }

  async getPlanItem(id: string) {
    return (
      await this.db
        .select()
        .from(productionPlanItems)
        .where(eq(productionPlanItems.productionPlanItemId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── production order (CRUD reads) ────────────────────────────────── */

  async listOrders(query: ListQuery): Promise<Page<typeof productionOrder.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(productionOrder)
      .where(query.cursor ? lt(productionOrder.productionOrderId, query.cursor) : undefined)
      .orderBy(desc(productionOrder.productionOrderId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.productionOrderId);
  }

  async getOrder(id: string) {
    return (
      await this.db
        .select()
        .from(productionOrder)
        .where(eq(productionOrder.productionOrderId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── flow: create order (vault integration) ──────────────────────── */

  /**
   * POST /v1/production-orders — start production against an APPROVED formula version.
   * Reads the real pick list server-side (FORMULA_LOOKUP.getPickList), expands the
   * bill-of-materials into production_order_ingredients, and emits production.order.created.
   * Returns 403 if the formula version is not approved/locked.
   */
  async createOrder(body: CreateOrder, principal: AuthPrincipal) {
    const picks = await this.formula.getPickList(body.formulaVersionId, {
      actorId: principal.userId,
    });
    if (!picks) {
      throw new ForbiddenException(
        'formula version not approved/locked — cannot start production',
      );
    }

    return this.db.transaction(async (tx) => {
      const order = (
        await tx
          .insert(productionOrder)
          .values({
            productionOrderId: uuidv7(),
            productionPlanItemId: body.productionPlanItemId ?? null,
            formulaVersionId: body.formulaVersionId,
            locationId: body.locationId ?? null,
            orderQty: num(body.orderQty),
            uomId: body.uomId ?? null,
            status: 'PENDING',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!order) throw new Error('insert failed: production_order');

      const productionOrderId = order.productionOrderId;

      for (const pick of picks) {
        await tx.insert(productionOrderIngredients).values({
          productionOrderIngredientId: uuidv7(),
          productionOrderId,
          materialId: pick.materialId,
          requiredQty: num((body.orderQty * pick.percentage) / 100),
          issuedQty: false,
          uomId: body.uomId ?? null,
          status: 'PENDING',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
      }

      await recordOutbox(
        tx,
        outbox,
        productionEvents.orderCreated,
        {
          productionOrderId,
          formulaVersionId: body.formulaVersionId,
          ingredientCount: picks.length,
        },
        productionOrderId,
      );

      return { order, ingredientCount: picks.length };
    });
  }

  /* ── production order ingredients (CRUD reads) ───────────────────── */

  async listOrderIngredients(
    query: ListQuery,
  ): Promise<Page<typeof productionOrderIngredients.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(productionOrderIngredients)
      .where(
        query.cursor
          ? lt(productionOrderIngredients.productionOrderIngredientId, query.cursor)
          : undefined,
      )
      .orderBy(desc(productionOrderIngredients.productionOrderIngredientId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.productionOrderIngredientId);
  }

  /** List the expanded bill-of-materials for one order (ids + requiredQty + issuedQty + uomId). */
  async listIngredientsForOrder(orderId: string) {
    return this.db
      .select({
        productionOrderIngredientId: productionOrderIngredients.productionOrderIngredientId,
        productionOrderId: productionOrderIngredients.productionOrderId,
        materialId: productionOrderIngredients.materialId,
        requiredQty: productionOrderIngredients.requiredQty,
        issuedQty: productionOrderIngredients.issuedQty,
        uomId: productionOrderIngredients.uomId,
      })
      .from(productionOrderIngredients)
      .where(eq(productionOrderIngredients.productionOrderId, orderId))
      .orderBy(desc(productionOrderIngredients.productionOrderIngredientId));
  }

  async getOrderIngredient(id: string) {
    return (
      await this.db
        .select()
        .from(productionOrderIngredients)
        .where(eq(productionOrderIngredients.productionOrderIngredientId, id))
        .limit(1)
    )[0] ?? null;
  }
}
