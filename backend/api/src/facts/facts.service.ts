/**
 * FactsService — the queries behind PB-06's RawProd Facts API. Read-only raw SQL over the
 * shared `PG_CLIENT` pool, same pattern DashboardService/ProcAnalyticsService already use for
 * cross-cluster reads (schema-per-cluster, one Postgres). Nothing here writes, and nothing
 * here reaches `formula.*` — see facts.contract.ts's header for why that is a property of
 * the fact-kind allow-list rather than a rule each method below has to remember.
 *
 * `permissionsForRoles` is the RE-CHECK: RawProd's own role→permission mapping
 * (iam.role_master / iam.role_permission_mapping / iam.permission_master — the tables
 * SecurityService already reads/writes for the two-person vault_approver/formulator grant
 * flow), never ALEMBIC's claim about what a role can do. A caller whose roles match nothing
 * in this table — which is every caller today, until PB-05's role alias map exists — holds
 * no permissions and gets FORBIDDEN from the controller, which is the correct, honest,
 * fail-closed state rather than a guess dressed up as an answer.
 */
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { PG_CLIENT } from "@core/backend-kernel";
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from "../bridge/bridge.tokens.js";
import { openSecret } from "../bridge/secret-box.js";
import { verifyBody } from "../bridge/signing.js";
import type { FactKind } from "./facts.contract.js";

const { connectorConfig } = bridgeSchema;

interface Blocker {
  readonly kind: "material_shortage" | "qc_hold" | "pending_approval";
  readonly detail: string;
}

@Injectable()
export class FactsService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Inject(BRIDGE_DB) private readonly bridgeDb: BridgeDb,
  ) {}

  /** Same secret, same algorithm as the event channel — signing.ts's own header states the
   *  two must "agree byte-for-byte or nothing verifies". A second endpoint on the one bridge
   *  trust relationship, not a second secret an admin has to provision. */
  async verifySignature(rawBody: string, header: string | null): Promise<boolean> {
    const config = (await this.bridgeDb.select().from(connectorConfig)
      .where(eq(connectorConfig.id, "default")).limit(1))[0];
    const secret = config?.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;
    if (!config?.enabled || !secret) return false;
    return verifyBody(rawBody, secret, header);
  }

  async permissionsForRoles(roleCodes: readonly string[]): Promise<ReadonlySet<string>> {
    if (roleCodes.length === 0) return new Set();
    const rows = (await this.sql`
      select distinct pm.permission_code as "permissionCode"
        from iam.role_master rm
        join iam.role_permission_mapping rpm on rpm.role_id = rm.role_id
        join iam.permission_master pm on pm.permission_id = rpm.permission_id
       where rm.role_code = ANY(${roleCodes})
         and coalesce(rm.status, 'ACTIVE') <> 'INACTIVE'
         and coalesce(rpm.status, 'ACTIVE') <> 'INACTIVE'`) as Array<{ permissionCode: string }>;
    return new Set(rows.map((r) => r.permissionCode));
  }

  async resolve(
    kind: FactKind,
    params: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown> | null> {
    switch (kind) {
      case "production_requirement_status":
        return params.orderRef ? this.productionRequirementStatus(params.orderRef) : null;
      case "material_availability": {
        if (!params.materialQuery) return null;
        const matches = await this.materialAvailability(params.materialQuery);
        return matches.length > 0 ? { matches } : null;
      }
      case "po_status":
        return params.poNumber ? this.poStatus(params.poNumber) : null;
      case "grn_status":
        return params.grnNumber ? this.grnStatus(params.grnNumber) : null;
      case "qc_status":
        return params.batchNumber ? this.qcStatus(params.batchNumber) : null;
      case "fg_atp":
        return params.batchNumber ? this.fgAtp(params.batchNumber) : null;
      case "dispatch_status":
        return params.soNumber ? this.dispatchStatus(params.soNumber) : null;
      default: {
        /* Unreachable while `kind` stays a `FactKind` — assigning it to `never` here is a
           compile error the moment a new member is added to `FACT_KINDS` without this
           switch being taught about it, the same "cannot forget a case" guarantee
           `bridge/contract.ts`'s decision functions rely on. */
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  }

  /** Production requirement/order status + blockers (§14/§32's worked example: "why isn't
   *  production moving"). Keyed on `order_ref` — ALEMBIC's own order number, the same code
   *  `bridge.production_requirement` was already keyed on by the importer (PB-07's channel),
   *  so ALEMBIC never needs a second, RawProd-minted id to ask this question. */
  private async productionRequirementStatus(orderRef: string): Promise<Record<string, unknown> | null> {
    const [pr] = (await this.sql`
      select production_requirement_id as "id", order_ref as "orderRef",
             mapped_sku as "mappedSku", lifecycle_status as "lifecycleStatus",
             status_reason as "statusReason", needed_by as "neededBy", priority,
             production_order_id as "productionOrderId"
        from bridge.production_requirement
       where order_ref = ${orderRef}
       order by created_dt desc
       limit 1`) as Array<Record<string, unknown>>;
    if (!pr) return null;

    let productionOrderStatus: string | null = null;
    const blockers: Blocker[] = [];
    const productionOrderId = pr.productionOrderId as string | null;

    if (productionOrderId) {
      const [po] = (await this.sql`
        select status from production.production_order
         where production_order_id = ${productionOrderId}`) as Array<{ status: string | null }>;
      productionOrderStatus = po?.status ?? null;

      const [shortage] = (await this.sql`
        select count(*)::int c from production.production_order_ingredients
         where production_order_id = ${productionOrderId}
           and coalesce(issued_qty, false) = false`) as Array<{ c: number }>;
      if ((shortage?.c ?? 0) > 0) {
        blockers.push({
          kind: "material_shortage",
          detail: `${shortage!.c} ingredient line(s) not yet issued`,
        });
      }

      const [qcHold] = (await this.sql`
        select count(*)::int c from production.production_qc pq
          join production.oil_batch_master ob on ob.oil_batch_id = pq.oil_batch_id
         where ob.production_order_id = ${productionOrderId}
           and upper(coalesce(pq.result, '')) in ('HOLD', 'FAIL', 'REJECT')`) as Array<{ c: number }>;
      if ((qcHold?.c ?? 0) > 0) {
        blockers.push({ kind: "qc_hold", detail: `${qcHold!.c} QC result(s) on hold or failed` });
      }

      const [pendingApproval] = (await this.sql`
        select count(*)::int c from procurement.purchase_request_approval pra
         where pra.approval_status = 'PENDING'
           and pra.purchase_request_id in (
             select pri.purchase_request_id from procurement.purchase_request_items pri
              where pri.material_id in (
                select material_id from production.production_order_ingredients
                 where production_order_id = ${productionOrderId}))`) as Array<{ c: number }>;
      if ((pendingApproval?.c ?? 0) > 0) {
        blockers.push({
          kind: "pending_approval",
          detail: `${pendingApproval!.c} purchase approval(s) pending`,
        });
      }
    }

    return { ...pr, productionOrderStatus, blockers };
  }

  /** Material availability by name/code prefix — on-hand minus every ACTIVE reservation
   *  (`released_dt is null`), never a formula ingredient quantity. RawProd, not ALEMBIC, is
   *  the authority on material identity, so the match runs here against `masterdata.material`
   *  rather than against a code ALEMBIC guessed at. */
  private async materialAvailability(materialQuery: string): Promise<ReadonlyArray<Record<string, unknown>>> {
    const q = materialQuery.toLowerCase().trim();
    if (!q) return [];
    const rows = (await this.sql`
      select m.material_id as "materialId", m.material_code as "materialCode",
             m.material_name as "materialName",
             coalesce(sum(ib.quantity_on_hand), 0)::float8 as "onHandQty",
             coalesce((
               select sum(sr.reserved_qty) from inventory.stock_reservation sr
                 join inventory.inventory_batch ib2 on ib2.inventory_batch_id = sr.inventory_batch_id
                where ib2.material_id = m.material_id and sr.released_dt is null
             ), 0)::float8 as "reservedQty"
        from masterdata.material m
        left join inventory.inventory_batch ib on ib.material_id = m.material_id
       where lower(m.material_code) = ${q} or lower(m.material_name) like ${`${q}%`}
       group by m.material_id, m.material_code, m.material_name
       order by m.material_name asc
       limit 5`) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...r,
      availableQty: Number(r.onHandQty) - Number(r.reservedQty),
    }));
  }

  private async poStatus(poNumber: string): Promise<Record<string, unknown> | null> {
    const [po] = (await this.sql`
      select po.purchase_order_id as "id", po.po_number as "poNumber", po.status,
             po.order_date as "orderDate", v.vendor_name as "vendorName"
        from procurement.purchase_order po
        left join procurement.vendor_details v on v.vendor_id = po.vendor_id
       where po.po_number = ${poNumber}
       limit 1`) as Array<Record<string, unknown>>;
    if (!po) return null;

    const approvals = (await this.sql`
      select approval_status as "approvalStatus", count(*)::int c
        from procurement.po_approval_order
       where purchase_order_id = ${po.id as string}
       group by approval_status`) as Array<Record<string, unknown>>;

    const [ack] = (await this.sql`
      select acknowledged_dt as "acknowledgedDt" from procurement.vendor_po_ack
       where purchase_order_id = ${po.id as string}
       order by acknowledged_dt desc nulls last
       limit 1`) as Array<{ acknowledgedDt: Date | null }>;

    return { ...po, approvals, vendorAcknowledged: Boolean(ack?.acknowledgedDt) };
  }

  private async grnStatus(grnNumber: string): Promise<Record<string, unknown> | null> {
    const [grn] = (await this.sql`
      select g.grn_id as "id", g.grn_number as "grnNumber", g.status,
             g.grn_date as "grnDate", v.vendor_name as "vendorName"
        from inventory.grn_master g
        left join procurement.vendor_details v on v.vendor_id = g.vendor_id
       where g.grn_number = ${grnNumber}
       limit 1`) as Array<Record<string, unknown>>;
    if (!grn) return null;

    const [items] = (await this.sql`
      select count(*)::int "lineCount",
             coalesce(sum(rejected_qty), 0)::float8 "rejectedQty",
             coalesce(sum(damaged_qty), 0)::float8 "damagedQty"
        from inventory.grn_items
       where grn_id = ${grn.id as string}`) as Array<Record<string, unknown>>;

    const qcResults = (await this.sql`
      select qi.overall_result as "overallResult", count(*)::int c
        from quality.qc_inspections qi
        join inventory.rm_batch_master b on b.rm_batch_id = qi.rm_batch_id
        join inventory.grn_items gi on gi.grn_item_id = b.grn_item_id
       where gi.grn_id = ${grn.id as string}
       group by qi.overall_result`) as Array<Record<string, unknown>>;

    return { ...grn, ...items, qcResults };
  }

  /** QC status by batch number — raw-material (`quality.qc_inspections`) checked first,
   *  falling back to an oil batch (`production.production_qc`); a batch number is unique
   *  within its own table but the two tables share no namespace, so both are worth trying
   *  before answering "not found". Never touches `formula.*`: the result names a batch and
   *  a verdict, never a composition. */
  private async qcStatus(batchNumber: string): Promise<Record<string, unknown> | null> {
    const rm = (await this.sql`
      select qi.overall_result as "overallResult", qi.inspection_dt as "inspectionDt"
        from quality.qc_inspections qi
        join inventory.rm_batch_master b on b.rm_batch_id = qi.rm_batch_id
       where b.batch_number = ${batchNumber}
       order by qi.inspection_dt desc nulls last
       limit 5`) as Array<Record<string, unknown>>;
    if (rm.length > 0) return { batchNumber, batchType: "rm", inspections: rm };

    const oil = (await this.sql`
      select pq.result as "overallResult", pq.inspection_dt as "inspectionDt"
        from production.production_qc pq
        join production.oil_batch_master ob on ob.oil_batch_id = pq.oil_batch_id
       where ob.batch_number = ${batchNumber}
       order by pq.inspection_dt desc nulls last
       limit 5`) as Array<Record<string, unknown>>;
    if (oil.length > 0) return { batchNumber, batchType: "oil", inspections: oil };

    return null;
  }

  /** FG available-to-promise, per the formula `finished_good_reservation`'s own schema
   *  comment gives: produced − dispatched − consumed − active reservations. */
  private async fgAtp(batchNumber: string): Promise<Record<string, unknown> | null> {
    const [batch] = (await this.sql`
      select b.finished_good_batch_id as "id", b.batch_number as "batchNumber",
             b.produced_qty as "producedQty", ps.sku_code as "skuCode"
        from packaging.finished_good_batch_master b
        left join packaging.product_sku ps on ps.product_sku_id = b.product_sku_id
       where b.batch_number = ${batchNumber}
       limit 1`) as Array<Record<string, unknown>>;
    if (!batch) return null;

    const [agg] = (await this.sql`
      select
        coalesce((select sum(dispatched_qty) from sales.dispatch_items
                   where finished_good_batch_id = ${batch.id as string}), 0)::float8 as "dispatchedQty",
        coalesce((select sum(consumed_qty) from packaging.finished_goods_batch_consumption
                   where finished_good_batch_id = ${batch.id as string}), 0)::float8 as "consumedQty",
        coalesce((select sum(reserved_qty) from packaging.finished_good_reservation
                   where finished_good_batch_id = ${batch.id as string}
                     and released_dt is null), 0)::float8 as "reservedQty"
    `) as Array<Record<string, unknown>>;

    // Single unconditional aggregate (no GROUP BY) — always exactly one row.
    const totals = agg!;
    const produced = Number(batch.producedQty ?? 0);
    const availableToPromise = produced
      - Number(totals.dispatchedQty) - Number(totals.consumedQty) - Number(totals.reservedQty);
    return { ...batch, ...totals, availableToPromise };
  }

  private async dispatchStatus(soNumber: string): Promise<Record<string, unknown> | null> {
    const [so] = (await this.sql`
      select sales_order_id as "id", so_number as "soNumber", status
        from sales.sales_order
       where so_number = ${soNumber}
       limit 1`) as Array<Record<string, unknown>>;
    if (!so) return null;

    const dispatches = (await this.sql`
      select dm.dispatch_id as "id", dm.status, dm.dispatch_date as "dispatchDate",
             dm.vehicle_number as "vehicleNumber", t.transporter_name as "transporterName",
             coalesce(sum(di.dispatched_qty), 0)::float8 as "dispatchedQty"
        from sales.dispatch_master dm
        left join sales.transporter_master t on t.transporter_id = dm.transporter_id
        left join sales.dispatch_items di on di.dispatch_id = dm.dispatch_id
       where dm.sales_order_id = ${so.id as string}
       group by dm.dispatch_id, dm.status, dm.dispatch_date, dm.vehicle_number, t.transporter_name
       order by dm.dispatch_date desc nulls last`) as Array<Record<string, unknown>>;

    return { ...so, dispatches };
  }
}
