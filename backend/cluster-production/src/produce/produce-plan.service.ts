/**
 * ProducePlanService — "Produce next", one click (lane produce, owner requirement 2026-09-29):
 * from a queued ALEMBIC requirement, create or extend a production plan item and its MASTER RUN
 * (production order), pre-filled with the requirement's SKU / pack / quantity and the product's
 * APPROVED formula version — shown to the floor as formula CODE + VERSION only.
 *
 *   1. The requirement must be ACCEPTED and not yet planned.
 *   2. SKU → product (packaging.product_sku / product_master) → the product's formula_id.
 *   3. The Vault (signed internal channel, `VaultApiClient.formulaLabels`) names the formula's
 *      current APPROVED/LOCKED version: id + number + code. No name, no content.
 *      None → the plan is BLOCKED with a plain reason ("No approved formula for this product in
 *      the Vault — a formulator must seal and approve one"), recorded on the requirement, and the
 *      formulator / vault approver roles are alerted (console feed + email). Nothing is created.
 *   4. The run's bill of materials comes from the Vault's coded pick list
 *      (`PlanningService.resolvePicks` → VAULT_PORT.resolvePickList — keyed material references
 *      resolved to this box's material ids; the recipe never leaves the Vault) for the run size in
 *      kg. The floor later reads the §109.7 CODED manufacturing instruction (floor codes +
 *      quantities) through the existing route, gated on production:manufacturing_instruction:read.
 *   5. EXTEND, not duplicate: when an open run (PLANNING, no pick list yet) of the same approved
 *      formula version already serves queued requirements, the requirement joins it — the run
 *      grows by this requirement's kg, its bill of materials is re-resolved for the new size, and
 *      its plan item's planned quantity grows with it. Otherwise a new plan item (on today's open
 *      plan, created if needed) and a new run are created. Either way, in ONE transaction:
 *      the requirement is linked and hears `ProductionScheduled` (only this requirement).
 *
 * The response carries ids, quantities and the formula code/version — never a material, a
 * percentage or a formula name (this box holds none of those to leak).
 */
import { ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { emitBridgeToRequirement, recordProduceAlert, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { VaultApiClient } from '@ra/cluster-formula';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { PlanningService } from '../planning/planning.service.js';
import { BLOCK_MESSAGES, FORMULA_ALERT_ROLES, requirementKg } from './produce-queue.service.js';

const { productionPlan, productionPlanItems } = productionSchema;

export interface PlanResult {
  mode: 'created' | 'extended';
  alembicRequirementId: string;
  productionOrderId: string;
  productionPlanId: string;
  productionPlanItemId: string | null;
  runQtyKg: number;
  addedQtyKg: number;
  ingredientCount: number;
  formula: { code: string | null; version: number | null };
}

interface RequirementRow {
  alembic_requirement_id: string;
  lifecycle_status: string;
  production_order_id: string | null;
  mapped_sku: string;
  pack_size: string | null;
  qty: string;
  uom: string;
  qty_kg: string | null;
  needed_by: Date | string;
}

/** A refused plan with a reason code the UI shows as plain words (BLOCK_MESSAGES). */
export class PlanBlockedException extends ConflictException {
  constructor(readonly reason: keyof typeof BLOCK_MESSAGES | string, message: string) {
    super({ message, error: 'PLAN_BLOCKED', reason });
  }
}

@Injectable()
export class ProducePlanService {
  constructor(
    @Inject(PRODUCTION_DB) private readonly db: ProductionDb,
    private readonly planning: PlanningService,
    @Optional() @Inject(VaultApiClient) private readonly vault?: Pick<VaultApiClient, 'formulaLabels'>,
  ) {}

  async planRequirement(alembicRequirementId: string, principal: AuthPrincipal): Promise<PlanResult> {
    const req = ((await this.db.execute(sql`
      select alembic_requirement_id::text, lifecycle_status, production_order_id::text, mapped_sku, pack_size,
             qty::text, uom, qty_kg::text, needed_by
        from bridge.production_requirement where alembic_requirement_id = ${alembicRequirementId}::uuid
    `)) as unknown as RequirementRow[])[0];
    if (!req) throw new NotFoundException(`No ALEMBIC requirement ${alembicRequirementId}.`);
    if (req.production_order_id) {
      throw new ConflictException(`This requirement is already planned (run ${req.production_order_id}).`);
    }
    if (req.lifecycle_status === 'REJECTED_MAPPING') throw new PlanBlockedException('UNKNOWN_SKU', BLOCK_MESSAGES.UNKNOWN_SKU!);
    if (req.lifecycle_status !== 'ACCEPTED') {
      throw new ConflictException(`This requirement is ${req.lifecycle_status}; only an accepted, open requirement can be planned.`);
    }

    const kg = requirementKg(req.qty_kg, req.qty, req.uom);
    if (kg === null || !(kg > 0)) throw new PlanBlockedException('QTY_NOT_IN_KG', BLOCK_MESSAGES.QTY_NOT_IN_KG!);

    const product = ((await this.db.execute(sql`
      select s.product_id::text, p.product_code, p.formula_id::text
        from packaging.product_sku s
        left join packaging.product_master p on p.product_id = s.product_id
       where s.sku_code = ${req.mapped_sku}
       order by s.product_sku_id limit 1
    `)) as unknown as Array<{ product_id: string | null; product_code: string | null; formula_id: string | null }>)[0];
    if (!product) throw new PlanBlockedException('UNKNOWN_SKU', BLOCK_MESSAGES.UNKNOWN_SKU!);
    if (!product.formula_id) {
      await this.block(req, product, 'NO_FORMULA_LINK');
      throw new PlanBlockedException('NO_FORMULA_LINK', BLOCK_MESSAGES.NO_FORMULA_LINK!);
    }

    const approved = await this.approvedVersion(product.formula_id);
    if (!approved) {
      await this.block(req, product, 'NO_APPROVED_FORMULA');
      throw new PlanBlockedException('NO_APPROVED_FORMULA', BLOCK_MESSAGES.NO_APPROVED_FORMULA!);
    }

    const kgUomId = await this.kgUomId();
    const open = ((await this.db.execute(sql`
      select o.production_order_id::text, o.order_qty::text, o.production_plan_item_id::text
        from production.production_order o
       where o.status = 'PLANNING' and o.formula_version_id = ${approved.formulaVersionId}::uuid
         and exists (select 1 from bridge.production_requirement r where r.production_order_id = o.production_order_id)
       order by o.created_dt asc
       limit 1
    `)) as unknown as Array<{ production_order_id: string; order_qty: string; production_plan_item_id: string | null }>)[0];

    const formula = { code: approved.formulaCode, version: approved.versionNumber };

    if (open) {
      const newQty = round4(Number(open.order_qty) + kg);
      const picks = await this.planning.resolvePicks(approved.formulaVersionId, newQty, principal);
      return this.db.transaction(async (tx) => {
        const { ingredientCount } = await this.planning.extendOrderTx(tx, open.production_order_id, open.order_qty, newQty, picks, principal);
        let planId: string | null = null;
        if (open.production_plan_item_id) {
          const item = (await tx.update(productionPlanItems)
            .set({ plannedQty: sql`coalesce(${productionPlanItems.plannedQty}, 0) + ${kg}`, updatedBy: principal.userId, updatedDt: new Date() })
            .where(eq(productionPlanItems.productionPlanItemId, open.production_plan_item_id))
            .returning({ planId: productionPlanItems.productionPlanId }))[0];
          planId = item?.planId ?? null;
        }
        await this.planning.linkRequirementTx(tx, alembicRequirementId, open.production_order_id);
        await emitBridgeToRequirement(tx, 'ProductionScheduled', alembicRequirementId, { production_order_id: open.production_order_id });
        return {
          mode: 'extended' as const, alembicRequirementId, productionOrderId: open.production_order_id,
          productionPlanId: planId ?? '', productionPlanItemId: open.production_plan_item_id,
          runQtyKg: newQty, addedQtyKg: kg, ingredientCount, formula,
        };
      });
    }

    const picks = await this.planning.resolvePicks(approved.formulaVersionId, kg, principal);
    return this.db.transaction(async (tx) => {
      const planId = await this.todaysPlan(tx, principal);
      const item = (await tx.insert(productionPlanItems).values({
        productionPlanItemId: uuidv7(), productionPlanId: planId, formulaId: product.formula_id,
        plannedQty: String(kg), uomId: kgUomId, status: 'ACTIVE',
        createdBy: principal.userId, updatedBy: principal.userId,
      }).returning())[0]!;
      const { order, ingredientCount } = await this.planning.insertOrderTx(tx, {
        productionPlanItemId: item.productionPlanItemId, formulaVersionId: approved.formulaVersionId,
        orderQty: kg, uomId: kgUomId ?? undefined, alembicRequirementId,
      }, picks, principal);
      return {
        mode: 'created' as const, alembicRequirementId, productionOrderId: order.productionOrderId,
        productionPlanId: planId, productionPlanItemId: item.productionPlanItemId,
        runQtyKg: kg, addedQtyKg: kg, ingredientCount, formula,
      };
    });
  }

  /** The formula's current approved version (id, number, code) from the Vault, or null. */
  private async approvedVersion(formulaId: string): Promise<{ formulaVersionId: string; versionNumber: number | null; formulaCode: string | null } | null> {
    if (!this.vault) throw new ServiceUnavailableException('The Vault is not reachable from this box, so the approved formula cannot be checked.');
    const labels = await this.vault.formulaLabels({ formulaVersionIds: [], formulaIds: [formulaId] }, { timeoutMs: 8000 });
    const f = labels.formulas.find((x) => x.formulaId === formulaId);
    if (!f?.approvedVersion) return null;
    return { formulaVersionId: f.approvedVersion.formulaVersionId, versionNumber: f.approvedVersion.versionNumber, formulaCode: f.formulaCode };
  }

  /** Records the block on the requirement and alerts the formula roles (once per product per day). */
  private async block(
    req: RequirementRow,
    product: { product_id: string | null; product_code: string | null },
    reason: 'NO_APPROVED_FORMULA' | 'NO_FORMULA_LINK',
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        update bridge.production_requirement
           set produce_block_reason = ${reason}, produce_blocked_at = now()
         where alembic_requirement_id = ${req.alembic_requirement_id}::uuid and production_order_id is null
      `);
      const what = `${product.product_code ?? req.mapped_sku} (SKU ${req.mapped_sku}${req.pack_size ? `, ${req.pack_size}` : ''})`;
      const day = new Date().toISOString().slice(0, 10);
      const kg = requirementKg(req.qty_kg, req.qty, req.uom);
      await recordProduceAlert(tx, {
        kind: 'formula_needed', severity: 'high',
        title: `Formula needed: ${what}`,
        detail: `${BLOCK_MESSAGES[reason]}. ${kg !== null ? `${kg} kg` : `${req.qty} ${req.uom}`} is waiting, needed by ${new Date(req.needed_by).toISOString().slice(0, 10)}.`,
        roles: FORMULA_ALERT_ROLES, refType: 'product', refId: product.product_id,
        dedupeKey: `formula_needed:${product.product_id ?? req.mapped_sku}:${day}`,
      });
    });
  }

  /** Today's open (DRAFT) production plan, created when there is none. */
  private async todaysPlan(tx: Parameters<Parameters<ProductionDb['transaction']>[0]>[0], principal: AuthPrincipal): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const existing = (await tx.select({ id: productionPlan.productionPlanId }).from(productionPlan)
      .where(and(eq(productionPlan.planDate, today), eq(productionPlan.status, 'DRAFT'))).limit(1))[0];
    if (existing) return existing.id;
    const created = (await tx.insert(productionPlan).values({
      productionPlanId: uuidv7(), planDate: today, status: 'DRAFT', createdBy: principal.userId, updatedBy: principal.userId,
    }).returning({ id: productionPlan.productionPlanId }))[0]!;
    return created.id;
  }

  private async kgUomId(): Promise<string | null> {
    const row = ((await this.db.execute(sql`
      select uom_id::text from platform.uom_master where lower(uom_code) in ('kg', 'kgs') order by uom_code limit 1
    `)) as unknown as Array<{ uom_id: string }>)[0];
    return row?.uom_id ?? null;
  }
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
