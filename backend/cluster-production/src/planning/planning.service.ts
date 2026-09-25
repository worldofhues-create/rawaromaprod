/**
 * PlanningService — production planning masters + the order vault integration:
 * PRODUCTION_PLAN, PRODUCTION_PLAN_ITEMS, PRODUCTION_ORDER, PRODUCTION_ORDER_INGREDIENTS.
 * CRUD (create + list + get) for the three header/line masters, plus the KEY flow:
 *
 *   createOrder → asks the Formula Vault, over the signed internal channel
 *                 (`VAULT_PORT.resolvePickList` — ProductionVaultPort), for the APPROVED formula
 *                 version's bill of materials for this order_qty: per line this box's material_id
 *                 (resolved here from the Vault's keyed material reference) and the required
 *                 quantity (computed in the Vault — the raw percentage never leaves it). Inserts the
 *                 production_order, one production_order_ingredients row per line, and emits
 *                 `production.order.created` in the SAME transaction. A version that is not
 *                 approved/locked (or does not exist) → ForbiddenException, as before.
 *
 * This box has no formula-database connection: the Vault isolation lets it reach only the
 * Vault API port, not vault-pg.
 *
 * production_order_ingredients are NEVER created directly — they are expanded here.
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; numerics
 * stringified via num(); ISO timestamps → Date. formula/location/uom/material refs are
 * id-only soft refs (plain uuid, no FK at this layer).
 */
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
import { emitBridgeOutbound, recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { VAULT_PORT, type VaultPort } from '@ra/cluster-formula';
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
    @Inject(VAULT_PORT) private readonly vault: VaultPort,
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
   * The caller's `production:production_order:write` is checked by the route; the Vault checks
   * the signed channel. Reads the coded bill of materials from the Vault (VAULT_PORT
   * .resolvePickList), expands it into production_order_ingredients, and emits
   * production.order.created. Returns 403 if the formula version is not approved/locked.
   */
  async createOrder(body: CreateOrder, principal: AuthPrincipal) {
    const picks = await this.vault.resolvePickList(body.formulaVersionId, body.orderQty, {
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
            // PLANNING (not PENDING): the pick-list step is gated on PLANNING/INPROGRESS, so a new
            // order must start here or it's a dead-end (audit H-C5). generatePickList → INPROGRESS.
            status: 'PLANNING',
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
          requiredQty: pick.requiredQty,
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

      // RP-EMIT (lane F6): if this order schedules production against an ALEMBIC-originated
      // requirement, link this order to it (guarded so a retry never re-links an
      // already-linked requirement to a different order) and emit ProductionScheduled toward
      // ALEMBIC, in this SAME transaction — a rollback of the order rolls back the link and
      // the emission too. No alembicRequirementId → this is RawProd-internal production;
      // emitBridgeOutbound's own lookup also no-ops if nothing is linked.
      if (body.alembicRequirementId) {
        // Security review R1 #3: the link used to match only "not yet linked", with no check
        // on lifecycle_status and no check on how many rows it actually touched — so scheduling
        // against a requirement that was already REJECTED_MAPPING'd or CANCELLED (or a bad/
        // unknown id) silently no-opped instead of failing loudly. Now the UPDATE also requires
        // lifecycle_status = 'ACCEPTED', and a zero-row result (not found / wrong status /
        // already linked) throws instead of continuing as if the link had succeeded.
        const linked = (await tx.execute(sql`
          update bridge.production_requirement
             set production_order_id = ${productionOrderId}
           where alembic_requirement_id = ${body.alembicRequirementId}
             and production_order_id is null
             and lifecycle_status = 'ACCEPTED'
           returning alembic_requirement_id
        `)) as unknown as Array<{ alembic_requirement_id: string }>;
        if (linked.length === 0) {
          throw new ConflictException(
            `Bridge requirement ${body.alembicRequirementId} could not be linked to a new production order: it does not exist, is not in ACCEPTED lifecycle status, or is already linked to another order.`,
          );
        }
      }
      await emitBridgeOutbound(tx, 'ProductionScheduled', productionOrderId, {
        production_order_id: productionOrderId,
        formula_version_id: body.formulaVersionId,
      });

      return { order, ingredientCount: picks.length };
    });
  }

  /* ── production order ingredients (CRUD reads) ───────────────────── */

  async listOrderIngredients(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Portal-audit WS4: enrich the masked "Worksheets" list with the material's RM alias so its
    // primary column shows the alias (NEVER the real material name — masking is preserved; the
    // interceptor still masks material_id). A correlated subquery picks one alias deterministically.
    // issued_qty stays a BOOLEAN flag (dictionary-locked) — it is an issued/not-issued indicator,
    // not a quantity.
    const rows = (await this.db.execute(sql`
      select p.production_order_ingredient_id as "productionOrderIngredientId",
             p.production_order_id as "productionOrderId",
             p.material_id as "materialId",
             (select a.alias_name from masterdata.rm_alias a
                where a.material_id = p.material_id order by a.rm_alias_id limit 1) as "aliasName",
             p.required_qty as "requiredQty",
             p.issued_qty as "issuedQty",
             p.uom_id as "uomId",
             p.status as "status"
        from production.production_order_ingredients p
       ${query.cursor ? sql`where p.production_order_ingredient_id < ${query.cursor}` : sql``}
       order by p.production_order_ingredient_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.productionOrderIngredientId as string);
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
