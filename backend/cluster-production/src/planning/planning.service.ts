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
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { emitBridgeOutbound, recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { mgToQty, uuidv7 } from '@core/data-kernel';
import { VAULT_PORT, type PickLine, type VaultPort } from '@ra/cluster-formula';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { productionEvents } from '../production.events.js';
import { paginate, num, type Page } from '../_helpers.js';
import { assertWeighable, orderSizeMg, releaseOrderTx, reserveOrderTx, shortfallText, type Shortfall } from './reserve.js';
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

/** The transaction handle PlanningService's `*Tx` methods run on. */
export type Tx = Parameters<Parameters<ProductionDb['transaction']>[0]>[0];

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
    const picks = await this.resolvePicks(body.formulaVersionId, body.orderQty, principal, body.uomId);
    return this.db.transaction((tx) => this.insertOrderTx(tx, body, picks, principal));
  }

  /**
   * The coded bill of materials for `orderQty` from the Vault; 403 if the version is not approved.
   * STOCK-FIX-RP (STK-7, STK-8): with a mass unit the order is sized in integer mg first (refused,
   * saying what to change, when the scales cannot weigh it) and the Vault splits the mg among the
   * lines so they total the order exactly, in whatever unit it was ordered.
   */
  async resolvePicks(formulaVersionId: string, orderQty: number, principal: AuthPrincipal, uomId?: string | null): Promise<PickLine[]> {
    const orderMg = await orderSizeMg(this.db, orderQty, uomId);
    const picks = await this.vault.resolvePickList(formulaVersionId, orderQty, {
      actorId: principal.userId,
    }, orderMg ?? undefined);
    if (!picks) {
      throw new ForbiddenException(
        'formula version not approved/locked — cannot start production',
      );
    }
    if (orderMg !== null) {
      if (picks.some((p) => typeof p.requiredMg !== 'number')) {
        throw new ConflictException('The Vault did not size this batch in mg, so its lines cannot be weighed exactly. Update the Vault box to the same release as this one.');
      }
      assertWeighable(picks.map((p) => p.requiredMg!));
    }
    return picks;
  }

  /** STOCK-FIX-RP (STK-9): what an order holds on the shelf, line by line (no names, no shares). */
  async orderReservation(orderId: string) {
    const order = await this.getOrder(orderId);
    if (!order) throw new NotFoundException(`production_order not found: ${orderId}`);
    const lines = (await this.db.execute(sql`
      select i.production_order_ingredient_id::text as "productionOrderIngredientId", i.material_id::text as "materialId",
             i.required_mg::text as "requiredMg", i.reserved_mg::text as "reservedMg", i.reserved_batch_id::text as "reservedBatchId",
             rb.batch_number as "reservedLot"
        from production.production_order_ingredients i
        left join inventory.inventory_batch ib on ib.inventory_batch_id = i.reserved_batch_id
        left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
       where i.production_order_id = ${orderId}::uuid
       order by i.created_dt, i.production_order_ingredient_id`)) as unknown as Array<Record<string, string | null>>;
    const items = Array.from(lines).map((l, n) => ({
      line: n + 1, productionOrderIngredientId: l.productionOrderIngredientId, materialId: l.materialId,
      requiredMg: l.requiredMg === null ? null : Number(l.requiredMg), reservedMg: l.reservedMg === null ? null : Number(l.reservedMg),
      reservedBatchId: l.reservedBatchId, reservedLot: l.reservedLot,
      short: l.requiredMg !== null && Number(l.reservedMg ?? 0) < Number(l.requiredMg),
    }));
    return { productionOrderId: orderId, status: order.status, lines: items, shortLines: items.filter((x) => x.short).length };
  }

  /**
   * STOCK-FIX-RP (STK-9): POST /v1/production-orders/:id/cancel. Releases every reservation the order
   * holds. Refused once anything has left the shelf for it (an issue), once it is on the floor, or
   * while an ALEMBIC requirement is waiting on it (that is rescheduled there, not dropped here).
   */
  async cancelOrder(orderId: string, reason: string, principal: AuthPrincipal) {
    const why = String(reason ?? '').trim();
    if (!why) throw new ConflictException('A cancelled production order needs a reason.');
    return this.db.transaction(async (tx) => {
      const order = (await tx.select().from(productionOrder).where(eq(productionOrder.productionOrderId, orderId)).for('update').limit(1))[0];
      if (!order) throw new NotFoundException(`production_order not found: ${orderId}`);
      if (!['PLANNING', 'INPROGRESS'].includes(String(order.status ?? ''))) throw new ConflictException(`Production order ${order.orderNumber ?? orderId} is ${order.status}; only a planned order can be cancelled.`);
      const [busy] = (await tx.execute(sql`
        select (select count(*) from production.material_issue where production_order_id = ${orderId}::uuid)::int as issues,
               (select count(*) from production.floor_job where production_order_id = ${orderId}::uuid)::int as jobs,
               (select count(*) from bridge.production_requirement where production_order_id = ${orderId}::uuid)::int as reqs`)) as unknown as Array<{ issues: number; jobs: number; reqs: number }>;
      if (busy!.issues > 0) throw new ConflictException('Material has already been issued to this order, so it cannot be cancelled: return the material first.');
      if (busy!.jobs > 0) throw new ConflictException('This order is on the floor, so it cannot be cancelled from planning.');
      if (busy!.reqs > 0) throw new ConflictException('An ALEMBIC requirement is scheduled on this order: reschedule the requirement, not the order.');
      const released = await releaseOrderTx(tx, orderId, principal.userId);
      const updated = (await tx.update(productionOrder).set({ status: 'CANCELLED', updatedBy: principal.userId, updatedDt: new Date() })
        .where(and(eq(productionOrder.productionOrderId, orderId), eq(productionOrder.status, order.status!))).returning())[0];
      if (!updated) throw new ConflictException('The order changed while it was being cancelled; try again.');
      await recordOutbox(tx, outbox, productionEvents.orderCancelled, { productionOrderId: orderId, reason: why }, orderId);
      return { order: updated, reservationsReleased: released };
    });
  }

  /**
   * The order write half of `createOrder`, inside the caller's transaction (lane produce: the
   * "Produce next" plan creates the plan item and the run in ONE transaction with it).
   */
  async insertOrderTx(tx: Tx, body: CreateOrder, picks: PickLine[], principal: AuthPrincipal) {
    const newOrderId = uuidv7();
    const order = (
      await tx
        .insert(productionOrder)
        .values({
          productionOrderId: newOrderId,
          // The tail of the uuidv7: its head is a clock and repeats across orders minted together.
          orderNumber: `MO-${newOrderId.replace(/-/g, '').slice(-12).toUpperCase()}`,
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
    await this.insertIngredientsTx(tx, productionOrderId, picks, body.uomId ?? null, principal);
    // STOCK-FIX-RP (STK-9): the order reserves its lines on the shelf as it is planned.
    const reservation = await reserveOrderTx(tx, productionOrderId, principal.userId);

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
    if (body.alembicRequirementId) await this.linkRequirementTx(tx, body.alembicRequirementId, productionOrderId);
    // Lane produce: the payload names the run only. `formula_version_id` used to ride along — a
    // field from RawProd's formula.* schema, which docs/bridge/EVENT_CONTRACT.md says must never
    // cross the bridge, and which ALEMBIC never read.
    await emitBridgeOutbound(tx, 'ProductionScheduled', productionOrderId, {
      production_order_id: productionOrderId,
    });

    return { order, ingredientCount: picks.length, reservation: reservationSummary(reservation) };
  }

  /**
   * Links an ACCEPTED, unlinked requirement to `productionOrderId`, or throws.
   * Security review R1 #3: the link used to match only "not yet linked", with no check on
   * lifecycle_status and no check on how many rows it actually touched — so scheduling against a
   * requirement that was already REJECTED_MAPPING'd or CANCELLED (or a bad/unknown id) silently
   * no-opped instead of failing loudly. Now the UPDATE also requires lifecycle_status =
   * 'ACCEPTED', and a zero-row result (not found / wrong status / already linked) throws.
   */
  async linkRequirementTx(tx: Tx, alembicRequirementId: string, productionOrderId: string): Promise<void> {
    const linked = (await tx.execute(sql`
      update bridge.production_requirement
         set production_order_id = ${productionOrderId},
             produce_block_reason = null, produce_blocked_at = null
       where alembic_requirement_id = ${alembicRequirementId}
         and production_order_id is null
         and lifecycle_status = 'ACCEPTED'
       returning alembic_requirement_id
    `)) as unknown as Array<{ alembic_requirement_id: string }>;
    if (linked.length === 0) {
      throw new ConflictException(
        `Bridge requirement ${alembicRequirementId} could not be linked to a new production order: it does not exist, is not in ACCEPTED lifecycle status, or is already linked to another order.`,
      );
    }
  }

  /**
   * Lane produce — grows an open (PLANNING, no pick list yet) run to `newQty`: its bill of
   * materials is replaced by the Vault's lines for the new quantity (`picks`, resolved by the
   * caller before the transaction) and its order_qty updated. Refused once the run has left
   * PLANNING: materials may already be picked against the old quantity.
   */
  async extendOrderTx(tx: Tx, productionOrderId: string, expectedQty: string, newQty: number, picks: PickLine[], principal: AuthPrincipal) {
    const order = (await tx.select().from(productionOrder)
      .where(eq(productionOrder.productionOrderId, productionOrderId)).for('update').limit(1))[0];
    if (!order) throw new ConflictException(`production order ${productionOrderId} no longer exists`);
    if (order.status !== 'PLANNING') {
      throw new ConflictException(`production order ${productionOrderId} has left PLANNING (${order.status}); it cannot be extended — plan a new run.`);
    }
    if (Number(order.orderQty ?? 0) !== Number(expectedQty)) {
      throw new ConflictException(`production order ${productionOrderId} changed while it was being extended; try again.`);
    }
    await releaseOrderTx(tx, productionOrderId, principal.userId); // STK-9: re-reserved below for the new size
    await tx.delete(productionOrderIngredients).where(eq(productionOrderIngredients.productionOrderId, productionOrderId));
    await this.insertIngredientsTx(tx, productionOrderId, picks, order.uomId ?? null, principal);
    const reservation = await reserveOrderTx(tx, productionOrderId, principal.userId);
    const updated = (await tx.update(productionOrder)
      .set({ orderQty: num(newQty), updatedBy: principal.userId, updatedDt: new Date() })
      .where(eq(productionOrder.productionOrderId, productionOrderId)).returning())[0]!;
    return { order: updated, ingredientCount: picks.length, reservation: reservationSummary(reservation) };
  }

  private async insertIngredientsTx(tx: Tx, productionOrderId: string, picks: PickLine[], uomId: string | null, principal: AuthPrincipal) {
    // STOCK-FIX-RP (STK-7): a line sized in mg is kept in the order's unit when four places hold it
    // exactly, else in g, where four places hold any whole mg (in kg they hold only 100 mg steps, which
    // is how F1 at 5 kg came to total 5,000,100 mg). required_mg is the line itself.
    let orderCode: string | null = null, gUomId: string | null = null;
    if (picks.some((p) => typeof p.requiredMg === 'number')) {
      orderCode = uomId ? ((await tx.execute(sql`select uom_code from platform.uom_master where uom_id = ${uomId}::uuid`)) as unknown as Array<{ uom_code: string | null }>)[0]?.uom_code ?? null : null;
      const [g] = (await tx.execute(sql`select uom_id::text from platform.uom_master where lower(uom_code) in ('g', 'gm', 'gram', 'grams') order by uom_code limit 1`)) as unknown as Array<{ uom_id: string }>;
      gUomId = g?.uom_id ?? null;
    }
    for (const pick of picks) {
      const mg = typeof pick.requiredMg === 'number' ? pick.requiredMg : null;
      const inOrderUnit = mg !== null && orderCode ? mgToQty(mg, orderCode) : null;
      if (mg !== null && inOrderUnit === null && !gUomId) throw new ConflictException('The unit g is not on file, so a line sized in mg cannot be stored exactly.');
      await tx.insert(productionOrderIngredients).values({
        productionOrderIngredientId: uuidv7(),
        productionOrderId,
        materialId: pick.materialId,
        requiredQty: mg === null ? pick.requiredQty : inOrderUnit ?? mgToQty(mg, 'g')!,
        requiredMg: mg,
        issuedQty: false,
        uomId: mg === null || inOrderUnit !== null ? uomId : gUomId,
        status: 'PENDING',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });
    }
  }

  /* ── production order ingredients (CRUD reads) ───────────────────── */

  async listOrderIngredients(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Portal-audit WS4: enrich the masked "Worksheets" list with the material's RM alias so its
    // primary column shows the alias (NEVER the real material name — masking is preserved; the
    // interceptor still masks material_id). A correlated subquery picks one alias deterministically.
    // issued_qty stays a BOOLEAN flag (dictionary-locked): is the line covered. issued_amount is the
    // quantity (STOCK3-2).
    const rows = (await this.db.execute(sql`
      select p.production_order_ingredient_id as "productionOrderIngredientId",
             p.production_order_id as "productionOrderId",
             p.material_id as "materialId",
             (select a.alias_name from masterdata.rm_alias a
                where a.material_id = p.material_id order by a.rm_alias_id limit 1) as "aliasName",
             p.required_qty as "requiredQty",
             p.issued_qty as "issuedQty",
             p.issued_amount as "issuedAmount",
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
        issuedAmount: productionOrderIngredients.issuedAmount,
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

/** STOCK-FIX-RP (STK-9): what planning reserved, as the order's response carries it. No names. */
function reservationSummary(r: { reserved: number; short: Shortfall[] }) {
  return { linesReserved: r.reserved, shortLines: r.short.length, short: r.short.map((s) => ({ line: s.line, needMg: s.needMg, bestLotFreeMg: s.bestLotFreeMg })),
    note: r.short.length ? `Short at planning: ${shortfallText(r.short)}. The floor job is refused until stock covers it.` : null };
}
