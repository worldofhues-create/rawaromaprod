/**
 * RfqService — CRUD over the RFQ + quotation tables (RFQ_MASTER, RFQ_ITEMS,
 * RFQ_VENDOR_MAPPINGS, QUOTATIONS, QUOTATION_ITEMS). quotations + quotation_items record a
 * vendor's response to an RFQ. Create stamps status "ACTIVE" + created_by/updated_by.
 * numeric → String(n); dates stay ISO date strings (date columns). Soft refs are plain uuids.
 */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import {
  PROCUREMENT_DB,
  procurementSchema,
  type ProcurementDb,
} from '../cluster-procurement.tokens.js';
import type { Page, ListQuery } from '../cluster-procurement.dtos.js';
import type {
  CreateQuotation,
  CreateQuotationItem,
  CreateRfqItem,
  CreateRfqMaster,
  CreateRfqVendorMapping,
  SelectQuotation,
} from '../cluster-procurement.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const { rfqMaster, rfqItems, rfqVendorMappings, quotations, quotationItems, auditEvents } =
  procurementSchema;

/** The drizzle transaction handle for this cluster's schema (used by the in-tx helpers). */
type Tx = Parameters<Parameters<ProcurementDb['transaction']>[0]>[0];

// §87 (AUTONOMOUS DECISION DEFAULTS — lane F8/rp-policy): the policy_type this service reads
// from iam.approval_matrix for "must the RFQ award approver differ from the RFQ creator". See
// PoService's PO_APPROVAL_POLICY_TYPE for the sibling PO-threshold policy in the same table.
const RFQ_AWARD_POLICY_TYPE = 'RFQ_AWARD_SEPARATION';

// The permission that lets a caller use the explicit award-override path (§87 "RFQ creator
// awarding their own RFQ" — "if organization has only one authorized approver, route to explicit
// override with reason/audit rather than deadlock silently"). Distinct from the base
// procurement:quotations:write permission the controller already requires for this route, so an
// ordinary quotation-writer cannot silently self-award — only someone ALSO holding this
// override permission (e.g. Procurement Head / Owner) can, and only with a reason.
const RFQ_AWARD_OVERRIDE_PERMISSION = 'procurement:quotations:award_override';

@Injectable()
export class RfqService {
  constructor(@Inject(PROCUREMENT_DB) private readonly db: ProcurementDb) {}

  /* ── rfq_master ─────────────────────────────────────────────────────── */

  async createRfqMaster(body: CreateRfqMaster, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(rfqMaster)
          .values({
            rfqNumber: body.rfqNumber ?? null,
            purchaseRequestId: body.purchaseRequestId ?? null,
            rfqDate: body.rfqDate ?? null,
            submissionDeadline: body.submissionDeadline ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listRfqMasters(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with the source PR number so the list shows which RFQ maps to which PR.
    const rows = (await this.db.execute(sql`
      select r.rfq_id as "rfqId", r.rfq_number as "rfqNumber", r.purchase_request_id as "purchaseRequestId",
             pr.pr_number as "prNumber", r.rfq_date as "rfqDate", r.submission_deadline as "submissionDeadline", r.status as "status"
        from procurement.rfq_master r
        left join procurement.purchase_request pr on pr.purchase_request_id = r.purchase_request_id
       ${query.cursor ? sql`where r.rfq_id < ${query.cursor}` : sql``}
       order by r.rfq_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.rfqId as string);
  }

  async getRfqMaster(id: string) {
    return (
      (await this.db.select().from(rfqMaster).where(eq(rfqMaster.rfqId, id)).limit(1))[0] ??
      null
    );
  }

  /* ── rfq_items ──────────────────────────────────────────────────────── */

  async createRfqItem(body: CreateRfqItem, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(rfqItems)
          .values({
            rfqId: body.rfqId ?? null,
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

  async listRfqItems(query: ListQuery): Promise<Page<typeof rfqItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(rfqItems)
      .where(query.cursor ? lt(rfqItems.rfqItemId, query.cursor) : undefined)
      .orderBy(desc(rfqItems.rfqItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.rfqItemId);
  }

  async getRfqItem(id: string) {
    return (
      (await this.db.select().from(rfqItems).where(eq(rfqItems.rfqItemId, id)).limit(1))[0] ??
      null
    );
  }

  /* ── rfq_vendor_mappings ────────────────────────────────────────────── */

  async createRfqVendorMapping(body: CreateRfqVendorMapping, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(rfqVendorMappings)
          .values({
            rfqId: body.rfqId ?? null,
            vendorId: body.vendorId ?? null,
            isSelectedVendor: body.isSelectedVendor ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listRfqVendorMappings(
    query: ListQuery,
  ): Promise<Page<typeof rfqVendorMappings.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(rfqVendorMappings)
      .where(
        query.cursor ? lt(rfqVendorMappings.rfqVendorMappingId, query.cursor) : undefined,
      )
      .orderBy(desc(rfqVendorMappings.rfqVendorMappingId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.rfqVendorMappingId);
  }

  async getRfqVendorMapping(id: string) {
    return (
      (
        await this.db
          .select()
          .from(rfqVendorMappings)
          .where(eq(rfqVendorMappings.rfqVendorMappingId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── quotations (vendor response) ───────────────────────────────────── */

  async createQuotation(body: CreateQuotation, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(quotations)
          .values({
            rfqId: body.rfqId ?? null,
            vendorId: body.vendorId ?? null,
            quotationNumber: body.quotationNumber ?? null,
            quotationDate: body.quotationDate ?? null,
            validUntilDate: body.validUntilDate ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listQuotations(query: ListQuery): Promise<Page<typeof quotations.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(quotations)
      .where(query.cursor ? lt(quotations.quotationId, query.cursor) : undefined)
      .orderBy(desc(quotations.quotationId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.quotationId);
  }

  async getQuotation(id: string) {
    return (
      (
        await this.db
          .select()
          .from(quotations)
          .where(eq(quotations.quotationId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── quotation_items (vendor response lines) ────────────────────────── */

  async createQuotationItem(body: CreateQuotationItem, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(quotationItems)
          .values({
            quotationId: body.quotationId ?? null,
            materialId: body.materialId ?? null,
            quotedQty: body.quotedQty != null ? String(body.quotedQty) : null,
            uomId: body.uomId ?? null,
            quotedRate: body.quotedRate != null ? String(body.quotedRate) : null,
            currencyId: body.currencyId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listQuotationItems(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with quotation number + vendor + material + rate so procurement can compare quotes.
    // Readers (Owner/Procurement) hold material reveal, so the material name is not a masking concern;
    // material_id is still surfaced so the interceptor would mask it for any non-reveal caller.
    const rows = (await this.db.execute(sql`
      select qi.quotation_item_id as "quotationItemId", qi.quotation_id as "quotationId",
             q.quotation_number as "quotationNumber", v.vendor_name as "vendorName",
             qi.material_id as "materialId", m.material_name as "materialName",
             qi.quoted_qty as "quotedQty", qi.quoted_rate as "quotedRate", qi.uom_id as "uomId", qi.status as "status"
        from procurement.quotation_items qi
        left join procurement.quotations q on q.quotation_id = qi.quotation_id
        left join procurement.vendor_details v on v.vendor_id = q.vendor_id
        left join masterdata.material m on m.material_id = qi.material_id
       ${query.cursor ? sql`where qi.quotation_item_id < ${query.cursor}` : sql``}
       order by qi.quotation_item_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.quotationItemId as string);
  }

  async getQuotationItem(id: string) {
    return (
      (
        await this.db
          .select()
          .from(quotationItems)
          .where(eq(quotationItems.quotationItemId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── FLOW: select winning quotation (RFQ → PO gap, RP-PROC-006) ───────── */

  /**
   * Resolve whether the RFQ-award separation-of-duties rule is ENFORCED for the organisation
   * that owns the RFQ (via the RFQ creator's iam.user_master.organization_id →
   * iam.approval_matrix, policy_type = RFQ_AWARD_SEPARATION). Mirrors PoService's
   * poApprovalThreshold, but the conservative DEFAULT is the opposite: unconfigured means
   * separation IS required (§87: "Default conservative policy: separate creator from final award
   * approver where roles permit"), whereas an unconfigured PO threshold means NO second-approver
   * requirement (there's no safe non-zero/non-infinite numeric default to assume). A boolean
   * carries no such ambiguity, so the safe default is simply "on".
   */
  private async rfqAwardSeparationRequired(tx: Tx, createdBy: string | null): Promise<boolean> {
    if (!createdBy) return true;
    let organizationId: string | null = null;
    try {
      const orgRows = (await tx.execute(sql`
        select u.organization_id as "organizationId"
          from iam.user_master u
         where u.user_id = ${createdBy}::uuid
         limit 1`)) as unknown as Array<{ organizationId: string | null }>;
      organizationId = orgRows[0]?.organizationId ?? null;
    } catch {
      return true; // unresolvable organisation → conservative default (enforced)
    }
    if (!organizationId) return true;

    const policyRows = (await tx.execute(sql`
      select is_enabled as "isEnabled"
        from iam.approval_matrix
       where organization_id = ${organizationId}
         and policy_type = ${RFQ_AWARD_POLICY_TYPE}
       limit 1`)) as unknown as Array<{ isEnabled: boolean | null }>;
    const configured = policyRows[0]?.isEnabled;
    return configured == null ? true : configured;
  }

  /**
   * POST /v1/quotations/:id/select — the formal "select winning quotation" step that was
   * missing from the RFQ → PO flow: createPurchaseOrder used to accept ANY quotationId with no
   * check that it had actually won the RFQ, so a PO could be raised off a quote nobody chose.
   * This marks exactly one quotation per RFQ as the awarded winner:
   *   - the quotation must belong to a real RFQ (quotation.rfqId not null)
   *   - its vendor must actually be a mapped/invited vendor for that RFQ (rfq_vendor_mappings) —
   *     a quote from a vendor who was never on the RFQ cannot win it
   *   - only ONE quotation per RFQ may ever hold status 'SELECTED' — awarding a second, different
   *     quotation for an RFQ that already has a winner is rejected (409) as a double award;
   *     re-selecting the SAME quotation that already won is a harmless no-op
   * On success, quotations.status → 'SELECTED' and the matching rfq_vendor_mappings row gets
   * is_selected_vendor = true (other vendor mappings for the same RFQ are cleared to false).
   *
   * §87 (AUTONOMOUS DECISION DEFAULTS — lane F8/rp-policy, resolving security review R1's
   * informational finding #7 above): separation of duties between the RFQ's creator and its
   * award approver, CONFIGURABLE per organisation via iam.approval_matrix (policy_type =
   * RFQ_AWARD_SEPARATION, the same table/mechanism PoService reads for the PO threshold):
   *   - organisation NOT configured, or configured with is_enabled = true → separation is
   *     ENFORCED (the conservative default per §87: "separate creator from final award approver
   *     where roles permit") — the RFQ's own creator cannot award its own RFQ.
   *   - organisation explicitly configured with is_enabled = false → separation is NOT enforced;
   *     the creator may award their own RFQ (an organisation's own opt-out, not this lane's
   *     unilateral call).
   *   - when separation is enforced and the caller IS the RFQ's creator, this is refused UNLESS
   *     the caller also supplies `overrideReason` (non-empty) AND holds the dedicated
   *     `procurement:quotations:award_override` permission (a caller who lacks this permission,
   *     e.g. an ordinary Procurement user, gets a hard refusal — never a silent auto-approve or
   *     deadlock). The override permission is meant for a Procurement Head/Owner role to use when
   *     the organisation genuinely has only one authorized approver, so the flow doesn't
   *     deadlock; every override is recorded to procurement.audit_events (actor, RFQ, quotation,
   *     reason) for later review.
   */
  async selectQuotation(id: string, body: SelectQuotation, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const quotation = (
        await tx.select().from(quotations).where(eq(quotations.quotationId, id)).limit(1)
      )[0];
      if (!quotation) throw new NotFoundException(`quotation not found: ${id}`);
      if (!quotation.rfqId) {
        throw new ConflictException(
          `Quotation ${id} is not linked to an RFQ and cannot be selected as a winner.`,
        );
      }

      // Security review R1 #1: lock the RFQ row FIRST, before the existing-winner check below.
      // Without this, two concurrent selectQuotation calls for DIFFERENT quotations of the SAME
      // RFQ could both read "no winner yet" before either committed, and both go on to mark
      // themselves SELECTED — a double award (TOCTOU). With the lock, the second call blocks
      // here until the first transaction commits or rolls back, so its existing-winner check
      // below always sees the up-to-date, post-commit result. This also happens to prevent a
      // Postgres deadlock the two transactions could otherwise hit on the rfq_vendor_mappings
      // updates further down (each transaction touches both vendors' mapping rows in opposite
      // order once both existing-winner checks pass unlocked).
      const rfq = (
        await tx.select().from(rfqMaster).where(eq(rfqMaster.rfqId, quotation.rfqId)).for('update')
      )[0];

      // §87 RFQ award separation of duties — see the method doc above.
      if (rfq?.createdBy && rfq.createdBy === principal.userId) {
        const separationRequired = await this.rfqAwardSeparationRequired(tx, rfq.createdBy);
        if (separationRequired) {
          const overrideReason = body.overrideReason?.trim();
          const canOverride = (principal.permissions || []).includes(
            RFQ_AWARD_OVERRIDE_PERMISSION,
          );
          if (!overrideReason || !canOverride) {
            throw new ForbiddenException(
              'Segregation of duties: you created this RFQ, so you cannot award its winning quotation. ' +
                'Ask another authorized approver to award it, or — if this organisation genuinely has ' +
                'only one authorized approver — resubmit with a non-empty overrideReason while holding ' +
                `the ${RFQ_AWARD_OVERRIDE_PERMISSION} permission (Procurement Head/Owner).`,
            );
          }
          // Explicit, permission-gated, reasoned override — audited rather than silently allowed.
          await tx.insert(auditEvents).values({
            actorId: principal.userId,
            action: 'rfq.award.override',
            entityType: 'rfq_master',
            entityId: quotation.rfqId,
            after: {
              quotationId: id,
              rfqCreatedBy: rfq.createdBy,
              overriddenBy: principal.userId,
              reason: overrideReason,
            },
            occurredAt: new Date(),
          });
        }
      }

      const vendorMapping = quotation.vendorId
        ? (
            await tx
              .select()
              .from(rfqVendorMappings)
              .where(
                and(
                  eq(rfqVendorMappings.rfqId, quotation.rfqId),
                  eq(rfqVendorMappings.vendorId, quotation.vendorId),
                ),
              )
              .limit(1)
          )[0]
        : undefined;
      if (!vendorMapping) {
        throw new ForbiddenException(
          `Vendor ${quotation.vendorId ?? '(none)'} was never invited/mapped to RFQ ${quotation.rfqId} — a quotation from an unmapped vendor cannot be selected.`,
        );
      }

      // Double-award guard: some OTHER quotation for this RFQ already won.
      const existingWinner = (
        await tx
          .select({ quotationId: quotations.quotationId })
          .from(quotations)
          .where(
            and(
              eq(quotations.rfqId, quotation.rfqId),
              eq(quotations.status, 'SELECTED'),
              ne(quotations.quotationId, id),
            ),
          )
          .limit(1)
      )[0];
      if (existingWinner) {
        throw new ConflictException(
          `RFQ ${quotation.rfqId} already has an awarded quotation (${existingWinner.quotationId}); cannot award a second winner (double award).`,
        );
      }

      let updated;
      try {
        updated = ensure(
          (
            await tx
              .update(quotations)
              .set({ status: 'SELECTED', updatedBy: principal.userId })
              .where(eq(quotations.quotationId, id))
              .returning()
          )[0],
        );
      } catch (err) {
        // Belt-and-suspenders: the partial unique index quotations_rfq_selected_uq (rfq_id
        // WHERE status='SELECTED') turns a double award into a clean 409 even if the row lock
        // above were ever bypassed, instead of a raw constraint-violation 500.
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException(
            `RFQ ${quotation.rfqId} already has an awarded quotation; cannot award a second winner (double award).`,
          );
        }
        throw err;
      }

      await tx
        .update(rfqVendorMappings)
        .set({ isSelectedVendor: false, updatedBy: principal.userId })
        .where(
          and(
            eq(rfqVendorMappings.rfqId, quotation.rfqId),
            ne(rfqVendorMappings.vendorId, quotation.vendorId ?? ''),
          ),
        );
      await tx
        .update(rfqVendorMappings)
        .set({ isSelectedVendor: true, updatedBy: principal.userId })
        .where(eq(rfqVendorMappings.rfqVendorMappingId, vendorMapping.rfqVendorMappingId));

      return updated;
    });
  }
}
