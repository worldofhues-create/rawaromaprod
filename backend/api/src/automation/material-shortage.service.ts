/**
 * MaterialShortageService — G3 rule: "production order APPROVED/RELEASED + material short (per
 * BOM vs available/unreserved stock) → stock requirement → DRAFT purchase request (grouped per
 * material/vendor mapping) → optional RFQ draft; never auto-issue a PO" (directive §18
 * "Material shortage": `approved production order + resolved material needs + available RM
 * short → Stock Requirement → draft PR`; §18 "Procurement": `PR approved → RFQ may be
 * generated`; award/PO approval still follows policy/SoD — this rule never touches
 * `procurement.purchase_order`).
 *
 * Consumes `production.order.created` (PlanningService.createOrder — backend/cluster-
 * production/src/planning/planning.service.ts) from `production.outbox`. The BOM is already
 * resolved into `production.production_order_ingredients` at that point (the order can only be
 * planned against an APPROVED/LOCKED formula version — PlanningService reads
 * `FORMULA_LOOKUP.getPickList`, which 403s otherwise), so "approved production order + resolved
 * material needs" is exactly the state this event signals. Dedupe key = productionOrderId — the
 * shortage check runs once, deterministically, at order-creation time.
 *
 * Shortfall = required_qty − (unreserved on-hand): `sum(inventory_batch.quantity_on_hand)` for
 * the material, minus `sum(stock_reservation.reserved_qty)` for that material's batches still
 * ACTIVE (released_dt IS NULL). Batches still in QUARANTINE never reach `inventory_batch` (see
 * QuarantineIntakeService / IncomingQcOutcomeService), so they are correctly excluded from
 * "available" without any extra filter.
 *
 * Grouping: each short material's DRAFT purchase request is grouped by its preferred vendor
 * (`procurement.vendor_rm_mapping.is_preferred`, falling back to any mapped vendor); materials
 * with no vendor mapping at all land in one shared "unmapped" DRAFT PR so they still surface in
 * the procurement queue for manual vendor assignment, per the actionable-queue principle in
 * §18 "RawProd requirement intake" (`else → reject mapping + actionable queue`) applied here to
 * an unmapped material rather than a rejected SKU. One optional RFQ draft is created per PR
 * (`AUTOMATION_AUTO_RFQ`, default on).
 *
 * Write set: `procurement.stock_requirement`, `procurement.purchase_request` (+ items, status
 * DRAFT), `procurement.rfq_master` (+ items, + vendor mapping when a vendor is known). Never
 * `procurement.purchase_order` — award/PO approval remains a human/policy decision (§19).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql, TransactionSql } from 'postgres';
import { AUTO_RFQ_ENABLED, AUTOMATION_POLL_MS, RULE, SYSTEM_ACTOR } from './automation.constants.js';
import { runIdempotent } from './ledger.js';

const EVENT_TYPE = 'production.order.created';

interface IngredientRow {
  material_id: string;
  required_qty: string;
  uom_id: string | null;
}
interface AvailabilityRow {
  material_id: string;
  available: string;
}
interface PreferredVendorRow {
  material_id: string;
  vendor_id: string;
}

@Injectable()
export class MaterialShortageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaterialShortageService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), AUTOMATION_POLL_MS);
    if (this.timer.unref) this.timer.unref();
    this.logger.log(`G3 material-shortage: polling ${EVENT_TYPE} every ${AUTOMATION_POLL_MS}ms`);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = (await this.sql`
        select o.aggregate_id::text as production_order_id
          from production.outbox o
         where o.type = ${EVENT_TYPE}
           and o.aggregate_id is not null
           and not exists (
             select 1 from automation.applied a
              where a.rule_code = ${RULE.MATERIAL_SHORTAGE} and a.dedupe_key = o.aggregate_id::text
                and a.status = 'DONE'
           )
         order by o.occurred_at asc
         limit 50
      `) as unknown as Array<{ production_order_id: string }>;
      for (const r of rows) await this.applyOne(r.production_order_id);
    } catch (err) {
      this.logger.warn(`material-shortage drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async applyOne(productionOrderId: string): Promise<void> {
    await runIdempotent({
      sql: this.sql,
      ruleCode: RULE.MATERIAL_SHORTAGE,
      dedupeKey: productionOrderId,
      eventType: EVENT_TYPE,
      aggregateId: productionOrderId,
      inputs: { productionOrderId },
      work: (tx) => this.evaluate(tx, productionOrderId),
    });
  }

  private async evaluate(tx: TransactionSql, productionOrderId: string) {
    const ingredients = (await tx`
      select material_id, required_qty, uom_id
        from production.production_order_ingredients
       where production_order_id = ${productionOrderId} and material_id is not null
    `) as unknown as IngredientRow[];

    if (ingredients.length === 0) {
      return { decision: 'NOOP' as const, reason: 'production order has no resolved material ingredients' };
    }

    const materialIds = [...new Set(ingredients.map((i) => i.material_id))];
    const availability = (await tx`
      select ib.material_id,
             coalesce(sum(ib.quantity_on_hand), 0)
               - coalesce((
                   select sum(sr.reserved_qty) from inventory.stock_reservation sr
                    where sr.inventory_batch_id in (
                      select inventory_batch_id from inventory.inventory_batch b2 where b2.material_id = ib.material_id
                    )
                      and sr.released_dt is null
                 ), 0) as available
        from inventory.inventory_batch ib
       where ib.material_id = any(${materialIds}::uuid[])
       group by ib.material_id
    `) as unknown as AvailabilityRow[];
    const availableByMaterial = new Map(availability.map((a) => [a.material_id, Number(a.available)]));

    const short = ingredients
      .map((i) => ({
        materialId: i.material_id,
        uomId: i.uom_id,
        requiredQty: Number(i.required_qty ?? 0),
        available: availableByMaterial.get(i.material_id) ?? 0,
      }))
      .map((i) => ({ ...i, shortQty: i.requiredQty - i.available }))
      .filter((i) => i.shortQty > 0.0001);

    if (short.length === 0) {
      return { decision: 'NOOP' as const, reason: 'sufficient unreserved stock for every resolved material' };
    }

    // One stock_requirement per short material.
    const stockRequirementIdByMaterial = new Map<string, string>();
    for (const s of short) {
      const stockRequirementId = randomUUID();
      await tx`
        insert into procurement.stock_requirement
          (stock_requirement_id, material_id, required_qty, uom_id, requirement_source, priority, status, created_by, updated_by)
        values (${stockRequirementId}, ${s.materialId}, ${s.shortQty}, ${s.uomId}, ${'PRODUCTION_ORDER:' + productionOrderId}, 'NORMAL', 'OPEN', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
      `;
      stockRequirementIdByMaterial.set(s.materialId, stockRequirementId);
    }

    // Group by preferred vendor (fallback: any mapped vendor); unmapped materials share one bucket.
    const preferred = (await tx`
      select distinct on (material_id) material_id, vendor_id
        from procurement.vendor_rm_mapping
       where material_id = any(${short.map((s) => s.materialId)}::uuid[])
       order by material_id, is_preferred desc nulls last, created_dt asc
    `) as unknown as PreferredVendorRow[];
    const vendorByMaterial = new Map(preferred.map((p) => [p.material_id, p.vendor_id]));

    const groups = new Map<string, typeof short>();
    for (const s of short) {
      const key = vendorByMaterial.get(s.materialId) ?? 'UNMAPPED';
      const bucket = groups.get(key) ?? [];
      bucket.push(s);
      groups.set(key, bucket);
    }

    const prIds: string[] = [];
    const rfqIds: string[] = [];
    for (const [vendorKey, items] of groups) {
      const vendorId = vendorKey === 'UNMAPPED' ? null : vendorKey;
      const purchaseRequestId = randomUUID();
      const prNumber = `PR-AUTO-${purchaseRequestId.slice(0, 8).toUpperCase()}`;
      const firstStockReq = stockRequirementIdByMaterial.get(items[0]!.materialId) ?? null;
      await tx`
        insert into procurement.purchase_request
          (purchase_request_id, pr_number, stock_requirement_id, priority, status, created_by, updated_by)
        values (${purchaseRequestId}, ${prNumber}, ${firstStockReq}, 'NORMAL', 'DRAFT', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
      `;
      prIds.push(purchaseRequestId);

      for (const item of items) {
        await tx`
          insert into procurement.purchase_request_items
            (purchase_request_item_id, purchase_request_id, material_id, required_qty, uom_id, status, created_by, updated_by)
          values (${randomUUID()}, ${purchaseRequestId}, ${item.materialId}, ${item.shortQty}, ${item.uomId}, 'ACTIVE', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
        `;
      }

      if (AUTO_RFQ_ENABLED) {
        const rfqId = randomUUID();
        await tx`
          insert into procurement.rfq_master (rfq_id, rfq_number, purchase_request_id, rfq_date, status, created_by, updated_by)
          values (${rfqId}, ${'RFQ-AUTO-' + rfqId.slice(0, 8).toUpperCase()}, ${purchaseRequestId}, current_date, 'DRAFT', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
        `;
        for (const item of items) {
          await tx`
            insert into procurement.rfq_items (rfq_item_id, rfq_id, material_id, required_qty, uom_id, status, created_by, updated_by)
            values (${randomUUID()}, ${rfqId}, ${item.materialId}, ${item.shortQty}, ${item.uomId}, 'ACTIVE', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
          `;
        }
        if (vendorId) {
          await tx`
            insert into procurement.rfq_vendor_mappings (rfq_vendor_mapping_id, rfq_id, vendor_id, is_selected_vendor, status, created_by, updated_by)
            values (${randomUUID()}, ${rfqId}, ${vendorId}, false, 'ACTIVE', ${SYSTEM_ACTOR}, ${SYSTEM_ACTOR})
          `;
        }
        rfqIds.push(rfqId);
      }
    }

    return {
      decision: 'FIRED' as const,
      reason: `${short.length} material(s) short across ${groups.size} vendor group(s); drafted ${prIds.length} purchase request(s)${AUTO_RFQ_ENABLED ? ` + ${rfqIds.length} RFQ draft(s)` : ''}`,
      outputs: { shortMaterialCount: short.length, purchaseRequestIds: prIds, rfqIds },
    };
  }
}
