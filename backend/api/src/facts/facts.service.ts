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
import { PO_OVERDUE_HOURS } from "../automation/automation.constants.js";
import { eq, lt } from "drizzle-orm";
import type { Sql } from "postgres";
import { PG_CLIENT } from "@core/backend-kernel";
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from "../bridge/bridge.tokens.js";
import { openSecret } from "../bridge/secret-box.js";
import { verifyBody } from "../bridge/signing.js";
import type { FactKind } from "./facts.contract.js";

const { connectorConfig, factsNonce } = bridgeSchema;

/** S3 security review item 5 — a signed request older than this (by its OWN `x-bridge-
 *  timestamp`) is refused even with a valid signature. Bounds how long a captured, still
 *  validly-signed request body stays presentable at all, before the nonce check even matters. */
const MAX_TIMESTAMP_AGE_S = 300;
/** Same margin `alembic-assertion.ts`'s clock-skew tolerance uses — a real clock difference
 *  between two independent boxes must not read as a forged, from-the-future timestamp. */
const CLOCK_SKEW_TOLERANCE_S = 5;

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

  /**
   * Same secret, same algorithm as the event channel — signing.ts's own header states the
   * two must "agree byte-for-byte or nothing verifies". A second endpoint on the one bridge
   * trust relationship, not a second secret an admin has to provision.
   *
   * S3 SECURITY REVIEW ITEM 5 — `timestamp` + `nonce` JOIN THE SIGNED MATERIAL, not just the
   * body. Before this, the signature covered only the raw body — a captured, validly-signed
   * request could be re-POSTed indefinitely (the HMAC never expires and never remembers it was
   * already used). The signed material is now `${timestamp}.${nonce}.${rawBody}` (ALEMBIC's
   * `rawprod-facts-client.ts` signs the identical string), so: (a) a request older than
   * `MAX_TIMESTAMP_AGE_S` is refused even with a perfect signature, and (b) a nonce, once
   * consumed via the `bridge.facts_nonce` unique-insert below, can never be presented again —
   * an attacker cannot strip the timestamp/nonce back off and resubmit just the body, because
   * doing so changes the signed material and breaks the signature.
   */
  async verifySignature(
    rawBody: string,
    header: string | null,
    timestamp: string | null,
    nonce: string | null,
  ): Promise<boolean> {
    if (!timestamp || !nonce) return false;
    const timestampSec = Number(timestamp);
    if (!Number.isFinite(timestampSec)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - timestampSec > MAX_TIMESTAMP_AGE_S) return false; // too old
    if (timestampSec - nowSec > CLOCK_SKEW_TOLERANCE_S) return false; // from the future

    const config = (await this.bridgeDb.select().from(connectorConfig)
      .where(eq(connectorConfig.id, "default")).limit(1))[0];
    const secret = config?.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;
    if (!config?.enabled || !secret) return false;

    const signedMaterial = `${timestamp}.${nonce}.${rawBody}`;
    if (!verifyBody(signedMaterial, secret, header)) return false;

    // ONLY NOW — after the signature over timestamp+nonce+body already verified — spend the
    // nonce. Checking it earlier would let an unauthenticated caller burn nonces for free;
    // checking it this late still closes the replay window because the signature itself binds
    // the nonce to this exact body, so an attacker without the secret cannot mint a second,
    // differently-nonced signature for a captured body.
    return this.consumeFactsNonce(nonce, timestampSec + MAX_TIMESTAMP_AGE_S);
  }

  /** Postgres-backed single-use check for the Facts API's `nonce`, the same shape (and the
   *  same cross-process reasoning) as `AuthService.consumeAssertionJti` in the RawProd auth
   *  cluster (S3 item 4's sibling fix for item 5). `INSERT ... ON CONFLICT DO NOTHING` is
   *  atomic across every process sharing this Postgres. */
  private async consumeFactsNonce(nonce: string, expiresAtSec: number): Promise<boolean> {
    try {
      await this.bridgeDb.delete(factsNonce).where(lt(factsNonce.expiresAt, new Date()));
    } catch {
      // Best-effort sweep — never let it block or falsely allow the single-use check below.
    }
    const inserted = await this.bridgeDb
      .insert(factsNonce)
      .values({ nonce, expiresAt: new Date(expiresAtSec * 1000) })
      .onConflictDoNothing()
      .returning({ nonce: factsNonce.nonce });
    return inserted.length > 0;
  }

  /**
   * S3 security review item 5 — resolve the caller's RawProd identity from `staffId` (the
   * ALEMBIC assertion `sub`/subject ALEMBIC attached to the request) via `alembic_subject`,
   * and derive permissions from THAT USER'S OWN RawProd role grants — never from `caller.roles`
   * in the request body, which is ALEMBIC's claim about itself and carries no authority here
   * (the same principle `AuthService.loginWithAssertion`'s header comment states for the
   * assertion bridge's own `roles` claim). A `staffId` bound to no RawProd user, or bound to a
   * suspended one, resolves to NO permissions — fail closed, the same honest "nothing granted"
   * `permissionsForRoles([])` already returns for an empty role list.
   */
  async permissionsForCaller(staffId: string): Promise<ReadonlySet<string>> {
    const [user] = (await this.sql`
      select user_id as "userId", is_active as "isActive", status
        from iam.user_master
       where alembic_subject = ${staffId}
       limit 1`) as Array<{ userId: string; isActive: boolean | null; status: string | null }>;
    if (!user) return new Set();
    const statusUpper = user.status ? user.status.toUpperCase() : null;
    if (user.isActive === false || (statusUpper !== null && statusUpper !== 'ACTIVE')) return new Set();

    const roleRows = (await this.sql`
      select distinct rm.role_code as "roleCode"
        from iam.user_role_mapping urm
        join iam.role_master rm on rm.role_id = urm.role_id
       where urm.user_id = ${user.userId}
         and coalesce(urm.status, 'ACTIVE') <> 'INACTIVE'`) as Array<{ roleCode: string | null }>;
    const roles = roleRows.map((r) => r.roleCode).filter((c): c is string => !!c);
    return this.permissionsForRoles(roles);
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
      case "production_blockers":
        return this.productionBlockers(params.orderRef);
      case "po_late":
        return this.poLate(params.poNumber);
      case "factory_status":
        return this.factoryStatus();
      case "batch_quarantine":
        return params.batchNumber ? this.batchQuarantine(params.batchNumber) : null;
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
        /* Golden journey lane/j2: "not yet issued" alone told ALEMBIC's ARIA nothing about
           WHY, and its fixed next-action ("raise a stock requirement") was wrong once the
           automation had already raised one and procurement had it on order. Say where the
           material actually is — in incoming-QC quarantine, on a PO, on a PR, or on the shelf
           awaiting issue — by document number only (never a material name: this payload
           crosses to ALEMBIC). */
        const where = await this.unissuedMaterialWhereabouts(productionOrderId);
        if (where.quarantinedBatches.length > 0) {
          blockers.push({
            kind: "qc_hold",
            detail: `incoming material batch ${where.quarantinedBatches.join(", ")} received and held in QC quarantine`
              + " (incoming inspection pending) — it cannot be issued until QC passes it",
          });
        }
        blockers.push({
          kind: "material_shortage",
          detail: `${shortage!.c} ingredient line(s) not yet issued${where.summary ? ` — ${where.summary}` : ""}`,
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

    // Most actionable first: a QC hold on material already in the building outranks the
    // generic "not yet issued" it causes.
    blockers.sort((a, b) => (a.kind === "qc_hold" ? 0 : 1) - (b.kind === "qc_hold" ? 0 : 1));
    return { ...pr, productionOrderStatus, blockers };
  }

  /** Where the not-yet-issued ingredients of a production order actually are (lane/j2):
   *  quarantined RM batches (by batch number), open POs, open PRs, or unreserved stock on the
   *  shelf. Document numbers only — no material identity leaves this method. */
  private async unissuedMaterialWhereabouts(
    productionOrderId: string,
  ): Promise<{ quarantinedBatches: string[]; summary: string }> {
    const unissued = this.sql`
      select material_id from production.production_order_ingredients
       where production_order_id = ${productionOrderId}
         and coalesce(issued_qty, false) = false and material_id is not null`;
    const quarantined = (await this.sql`
      select batch_number from inventory.rm_batch_master
       where material_id in (${unissued}) and status = 'QUARANTINE'
       order by created_dt asc limit 5`) as Array<{ batch_number: string | null }>;
    const openPos = (await this.sql`
      select distinct po.po_number, po.status from procurement.purchase_order po
        join procurement.purchase_order_items poi on poi.purchase_order_id = po.purchase_order_id
       where poi.material_id in (${unissued})
         and upper(coalesce(po.status, '')) in ('DRAFT','PENDING_L2_APPROVAL','APPROVED','ISSUED','ACKNOWLEDGED')
       order by po.po_number limit 5`) as Array<{ po_number: string | null; status: string | null }>;
    const openPrs = (await this.sql`
      select distinct pr.pr_number, pr.status from procurement.purchase_request pr
        join procurement.purchase_request_items pri on pri.purchase_request_id = pr.purchase_request_id
       where pri.material_id in (${unissued})
         and upper(coalesce(pr.status, '')) in ('DRAFT','SUBMITTED','APPROVED')
       order by pr.pr_number limit 5`) as Array<{ pr_number: string | null; status: string | null }>;
    const [onShelf] = (await this.sql`
      select count(*)::int c from production.production_order_ingredients poi
       where poi.production_order_id = ${productionOrderId}
         and coalesce(poi.issued_qty, false) = false
         and coalesce(poi.required_qty, 0) <= (
           select coalesce(sum(ib.quantity_on_hand), 0) from inventory.inventory_batch ib
            where ib.material_id = poi.material_id)`) as Array<{ c: number }>;

    const parts: string[] = [];
    if ((onShelf?.c ?? 0) > 0) parts.push(`${onShelf!.c} line(s) in stock, awaiting pick/issue`);
    if (openPos.length > 0) parts.push(`on order: ${openPos.map((p) => `${p.po_number} (${p.status})`).join(", ")}`);
    else if (openPrs.length > 0) parts.push(`purchase request ${openPrs.map((p) => `${p.pr_number} (${p.status})`).join(", ")}`);
    return {
      quarantinedBatches: quarantined.map((q) => q.batch_number ?? "(unnumbered)"),
      summary: parts.join("; "),
    };
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

  /* ── OPS-GREEN §16 (lane ARIA) ─────────────────────────────────────────────────────────
   *
   * Four read-only facts for the operating questions ARIA must answer from authority. Each one
   * reuses a rule RawProd already owns rather than stating a second one: the blocker
   * whereabouts are `unissuedMaterialWhereabouts` (golden journey lane/j2), the approval
   * overdue threshold is `PO_OVERDUE_HOURS` (the G3 alert scan's own constant), and a batch's
   * quarantine is read off `rm_batch_master.status` / the QC tables the inspection service
   * writes. NO MATERIAL IDENTITY IS JOINED TO A PRODUCTION ORDER in any payload below -- that
   * pairing is formula composition and stays in the Vault. */

  /** "Which material blocks production?" Open production orders with un-issued ingredient
   *  lines, and where that material is (quarantine batch / PO / PR / on the shelf), by
   *  document number only. `orderRef` narrows to one ALEMBIC order; absent, the ten oldest
   *  blocked production orders. Null when an order ref was named and is not on file. */
  private async productionBlockers(orderRef?: string): Promise<Record<string, unknown> | null> {
    const rows = (orderRef
      ? await this.sql`
          select po.production_order_id as "productionOrderId", po.status, pr.order_ref as "orderRef",
                 pr.needed_by as "neededBy"
            from bridge.production_requirement pr
            join production.production_order po on po.production_order_id = pr.production_order_id
           where pr.order_ref = ${orderRef}
           order by pr.created_dt desc
           limit 1`
      : await this.sql`
          select po.production_order_id as "productionOrderId", po.status,
                 (select pr.order_ref from bridge.production_requirement pr
                   where pr.production_order_id = po.production_order_id
                   order by pr.created_dt desc limit 1) as "orderRef",
                 (select pr.needed_by from bridge.production_requirement pr
                   where pr.production_order_id = po.production_order_id
                   order by pr.created_dt desc limit 1) as "neededBy"
            from production.production_order po
           where upper(coalesce(po.status, '')) not in ('COMPLETED', 'CANCELLED', 'CLOSED')
             and exists (select 1 from production.production_order_ingredients i
                          where i.production_order_id = po.production_order_id
                            and coalesce(i.issued_qty, false) = false)
           order by po.created_dt asc
           limit 10`) as Array<{
            productionOrderId: string; status: string | null; orderRef: string | null; neededBy: Date | null;
          }>;
    if (orderRef && rows.length === 0) return null;

    const blocked: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      const [lines] = (await this.sql`
        select count(*)::int c from production.production_order_ingredients
         where production_order_id = ${r.productionOrderId}
           and coalesce(issued_qty, false) = false`) as Array<{ c: number }>;
      if ((lines?.c ?? 0) === 0) continue;
      const where = await this.unissuedMaterialWhereabouts(r.productionOrderId);
      blocked.push({
        /* The production order has no human number of its own; the ALEMBIC order it was raised
           for is the code both sides quote, and the short id is the fallback a RawProd operator
           can still search by. */
        productionOrder: r.orderRef ?? `PRD-${r.productionOrderId.slice(0, 8)}`,
        orderRef: r.orderRef,
        status: r.status,
        neededBy: r.neededBy,
        unissuedLines: lines!.c,
        quarantinedBatches: where.quarantinedBatches,
        whereabouts: where.summary,
      });
    }
    return { scope: orderRef ? "order" : "factory", blocked };
  }

  /** "Which PO is late?" Two lateness rules, both already RawProd's: DELIVERY late -- an
   *  approved/issued/acknowledged PO past the vendor's accepted delivery date (else the PR's
   *  expected date) with no GRN against it; APPROVAL late -- a PO still awaiting approval past
   *  `PO_OVERDUE_HOURS`, the same threshold the G3 alert scan raises on. `poNumber` narrows to
   *  one PO (null when unknown); absent, up to ten of each, oldest first. */
  private async poLate(poNumber?: string): Promise<Record<string, unknown> | null> {
    if (poNumber) {
      const [exists] = (await this.sql`
        select 1 as one from procurement.purchase_order where po_number = ${poNumber} limit 1`) as Array<{ one: number }>;
      if (!exists) return null;
    }
    const byPo = poNumber ?? null;
    const deliveryLate = (await this.sql`
      select po.po_number as "poNumber", po.status,
             coalesce(ack.accepted_delivery_date, req.expected_delivery_date) as "dueDate",
             (current_date - coalesce(ack.accepted_delivery_date, req.expected_delivery_date))::int as "daysLate",
             ack.accepted_delivery_date is not null as "vendorCommitted"
        from procurement.purchase_order po
        left join lateral (
          select a.accepted_delivery_date from procurement.vendor_po_ack a
           where a.purchase_order_id = po.purchase_order_id
           order by a.acknowledged_dt desc nulls last limit 1) ack on true
        left join procurement.purchase_request req on req.purchase_request_id = po.purchase_request_id
       where upper(coalesce(po.status, '')) in ('APPROVED', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED')
         and coalesce(ack.accepted_delivery_date, req.expected_delivery_date) < current_date
         and not exists (select 1 from inventory.grn_master g
                          where g.purchase_order_id = po.purchase_order_id
                            and upper(coalesce(g.status, '')) not in ('CANCELLED', 'REJECTED'))
         and (${byPo}::text is null or po.po_number = ${byPo})
       order by 3 asc
       limit 10`) as Array<Record<string, unknown>>;
    const approvalLate = (await this.sql`
      select po.po_number as "poNumber", po.status, po.updated_dt as "pendingSince"
        from procurement.purchase_order po
       where upper(coalesce(po.status, '')) in ('DRAFT', 'PENDING', 'PENDING_APPROVAL', 'PENDING_L2_APPROVAL')
         and po.updated_dt <= now() - (${PO_OVERDUE_HOURS} || ' hours')::interval
         and (${byPo}::text is null or po.po_number = ${byPo})
       order by po.updated_dt asc
       limit 10`) as Array<Record<string, unknown>>;
    return { scope: poNumber ? "po" : "all", overdueHours: PO_OVERDUE_HOURS, deliveryLate, approvalLate };
  }

  /** "What is the factory status?" Counts only -- no identities, no quantities of any
   *  ingredient -- each read off the table that owns the state. */
  private async factoryStatus(): Promise<Record<string, unknown>> {
    const byStatus = (await this.sql`
      select coalesce(upper(status), 'UNKNOWN') as status, count(*)::int c
        from production.production_order
       where upper(coalesce(status, '')) not in ('COMPLETED', 'CANCELLED', 'CLOSED')
       group by 1 order by 1`) as Array<{ status: string; c: number }>;
    const [counts] = (await this.sql`
      select
        (select count(distinct i.production_order_id)::int
           from production.production_order_ingredients i
           join production.production_order po on po.production_order_id = i.production_order_id
          where coalesce(i.issued_qty, false) = false
            and upper(coalesce(po.status, '')) not in ('COMPLETED', 'CANCELLED', 'CLOSED')) as "blockedOrders",
        (select count(*)::int from inventory.rm_batch_master where status = 'QUARANTINE') as "quarantinedBatches",
        (select count(*)::int from quality.qc_inspections where upper(coalesce(overall_result, '')) = 'HOLD') as "qcHolds",
        (select count(*)::int from production.production_qc where upper(coalesce(result, '')) in ('HOLD', 'FAIL', 'REJECT')) as "productionQcHolds",
        (select count(*)::int from procurement.purchase_order
          where upper(coalesce(status, '')) in ('DRAFT', 'PENDING', 'PENDING_APPROVAL', 'PENDING_L2_APPROVAL')) as "posAwaitingApproval",
        (select count(*)::int from procurement.purchase_order
          where upper(coalesce(status, '')) in ('APPROVED', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED')) as "posOpen",
        (select count(*)::int from procurement.purchase_request_approval where approval_status = 'PENDING') as "prApprovalsPending",
        (select count(*)::int from bridge.production_requirement
          where production_order_id is null) as "requirementsAwaitingPlan"
    `) as Array<Record<string, number>>;
    return { productionOrdersByStatus: byStatus, ...counts! };
  }

  /** "Why is this batch quarantined?" The batch's own state, the QC verdicts against it and
   *  the receipt it came in on -- raw-material batch first, then an oil batch, then a finished
   *  good batch (the three share no namespace). The reason is DERIVED FROM THOSE FACTS in a
   *  fixed order, never written as prose by a caller. Batch and document numbers only. */
  private async batchQuarantine(batchNumber: string): Promise<Record<string, unknown> | null> {
    const [rm] = (await this.sql`
      select b.rm_batch_id as "id", b.status, b.expiry_date as "expiryDate", b.created_dt as "receivedAt",
             g.grn_number as "grnNumber", po.po_number as "poNumber"
        from inventory.rm_batch_master b
        left join inventory.grn_items gi on gi.grn_item_id = b.grn_item_id
        left join inventory.grn_master g on g.grn_id = gi.grn_id
        left join procurement.purchase_order po on po.purchase_order_id = g.purchase_order_id
       where b.batch_number = ${batchNumber}
       order by b.created_dt desc
       limit 1`) as Array<Record<string, unknown>>;
    if (rm) {
      const inspections = (await this.sql`
        select overall_result as "result", status, inspection_dt as "inspectionDt"
          from quality.qc_inspections
         where rm_batch_id = ${rm.id as string}
         order by inspection_dt desc nulls last, created_dt desc
         limit 5`) as Array<{ result: string | null; status: string | null; inspectionDt: Date | null }>;
      const { id: _id, ...batch } = rm;
      return {
        batchNumber, batchType: "rm", ...batch, inspections,
        reason: quarantineReason(String(rm.status ?? ""), inspections[0]?.result ?? null,
          rm.expiryDate as Date | null),
      };
    }
    const [oil] = (await this.sql`
      select oil_batch_id as "id", status, produced_dt as "producedAt"
        from production.oil_batch_master where batch_number = ${batchNumber} limit 1`) as Array<Record<string, unknown>>;
    if (oil) {
      const inspections = (await this.sql`
        select result, status, inspection_dt as "inspectionDt"
          from production.production_qc where oil_batch_id = ${oil.id as string}
         order by inspection_dt desc nulls last, created_dt desc
         limit 5`) as Array<{ result: string | null; status: string | null; inspectionDt: Date | null }>;
      const held = inspections.find((i) => /HOLD|FAIL|REJECT/i.test(i.result ?? ""));
      const { id: _id, ...batch } = oil;
      return {
        batchNumber, batchType: "oil", ...batch, inspections,
        reason: quarantineReason(String(oil.status ?? ""), held?.result ?? inspections[0]?.result ?? null, null),
      };
    }
    const [fg] = (await this.sql`
      select status, expiry_date as "expiryDate", manufacturing_date as "manufacturingDate"
        from packaging.finished_good_batch_master where batch_number = ${batchNumber} limit 1`) as Array<Record<string, unknown>>;
    if (fg) {
      return {
        batchNumber, batchType: "fg", ...fg, inspections: [],
        reason: quarantineReason(String(fg.status ?? ""), null, fg.expiryDate as Date | null),
      };
    }
    return null;
  }
}

/** The reason a batch is held, from the facts in a FIXED order -- a QC verdict outranks the
 *  state it caused, and expiry is its own reason. `quarantined` is false when the batch is not
 *  held at all, so ARIA can say "it is not quarantined" rather than invent why it is. */
export function quarantineReason(
  status: string, latestResult: string | null, expiryDate: Date | null,
): { quarantined: boolean; code: string; detail: string } {
  const st = status.toUpperCase();
  const res = (latestResult ?? "").toUpperCase();
  const heldStates = new Set(["QUARANTINE", "HOLD", "ON_HOLD", "REJECTED", "BLOCKED"]);
  const expired = expiryDate !== null && new Date(expiryDate).getTime() < Date.now();
  const quarantined = heldStates.has(st) || /HOLD|FAIL|REJECT/.test(res) || expired;
  if (!quarantined) return { quarantined: false, code: "not_held", detail: `status ${st || "UNKNOWN"}` };
  if (/FAIL|REJECT/.test(res)) {
    return { quarantined: true, code: "qc_failed", detail: `QC result ${res}: awaiting disposal / return to vendor` };
  }
  if (/HOLD/.test(res)) return { quarantined: true, code: "qc_hold", detail: "QC placed this batch on HOLD" };
  if (expired) return { quarantined: true, code: "expired", detail: "the batch is past its expiry date" };
  if (st === "QUARANTINE" && !res) {
    return { quarantined: true, code: "awaiting_incoming_qc", detail: "received into quarantine; incoming QC inspection not yet recorded" };
  }
  return { quarantined: true, code: "held", detail: `batch status ${st}${res ? `, latest QC ${res}` : ""}` };
}
