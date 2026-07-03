/**
 * InspectionsService — the QC inspection document + its child rows: QC_INSPECTIONS,
 * QC_RESULT_DETAILS, QC_ATTACHMENTS, QC_DISPOSITION. CRUD for all four, plus the inspection
 * FLOW:
 *
 *   create        → a PENDING inspection against an rm_batch_id (overall_result = "PENDING").
 *   addResults    → append one or more qc_result_details rows to an inspection.
 *   dispose       → insert a qc_disposition (ACCEPT/REJECT/REWORK), set the inspection's
 *                   overall_result to the disposition code, and — inside the SAME
 *                   transaction — record a `quality.qc.passed` (ACCEPT) or
 *                   `quality.qc.failed` (REJECT) outbox event. REWORK records no event.
 *
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; numerics are
 * stringified at insert; ISO timestamps → Date. rm_batch_id / inspector / role / document /
 * parameter are cross-schema or dict-soft refs (plain uuid, no FK at this layer).
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { QUALITY_DB, qualitySchema, type QualityDb } from '../quality.tokens.js';
import { qualityEvents } from '../quality.events.js';
import type {
  AddResults,
  CreateQcAttachment,
  CreateQcInspection,
  DisposeInspection,
  ListQuery,
} from '../quality.dtos.js';

const { qcInspections, qcResultDetails, qcAttachments, qcDisposition, outbox } = qualitySchema;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class InspectionsService {
  constructor(@Inject(QUALITY_DB) private readonly db: QualityDb) {}

  /* ── qc inspections (document) ────────────────────────────────────── */

  /** Open a PENDING inspection against an rm_batch_id. */
  async createInspection(body: CreateQcInspection, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(qcInspections)
        .values({
          qcInspectionId: uuidv7(),
          rmBatchId: body.rmBatchId,
          inspectionRoleId: body.inspectionRoleId ?? null,
          inspectorUserId: body.inspectorUserId ?? null,
          inspectionDt: body.inspectionDt ? new Date(body.inspectionDt) : null,
          overallResult: 'PENDING',
          status: 'PENDING',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: qc_inspections');
    return row;
  }

  async listInspections(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with the RM batch number (QC-03 — the Test queue showed a raw uuid). The batch
    // number isn't the formula; rm_batch_id is retained so masking still applies to the id itself.
    const rows = (await this.db.execute(sql`
      select qi.qc_inspection_id as "qcInspectionId", qi.rm_batch_id as "rmBatchId",
             b.batch_number as "batchNumber", qi.overall_result as "overallResult",
             qi.inspection_dt as "inspectionDt", qi.status as "status"
        from quality.qc_inspections qi
        left join inventory.rm_batch_master b on b.rm_batch_id = qi.rm_batch_id
       ${query.cursor ? sql`where qi.qc_inspection_id < ${query.cursor}` : sql``}
       order by qi.qc_inspection_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.qcInspectionId as string);
  }

  async getInspection(id: string) {
    return (
      await this.db.select().from(qcInspections).where(eq(qcInspections.qcInspectionId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── flow: add results ────────────────────────────────────────────── */

  /** POST /v1/qc-inspections/:id/results — append qc_result_details rows. */
  async addResults(inspectionId: string, body: AddResults, principal: AuthPrincipal) {
    const inspection = await this.getInspection(inspectionId);
    if (!inspection) throw new NotFoundException(`qc_inspection not found: ${inspectionId}`);

    const values = body.results.map((r) => ({
      qcResultDetailId: uuidv7(),
      qcInspectionId: inspectionId,
      qcParameterId: r.qcParameterId ?? null,
      observedValue: r.observedValue === undefined ? null : String(r.observedValue),
      observedText: r.observedText ?? null,
      result: r.result ?? null,
      status: 'ACTIVE',
      createdBy: principal.userId,
      updatedBy: principal.userId,
    }));

    return this.db.insert(qcResultDetails).values(values).returning();
  }

  /* ── qc result details (CRUD) ─────────────────────────────────────── */

  /** Enriched with the parameter name so the grid reads "Density = 0.87 (PASS)" rather than
   * a raw parameter uuid. Raw join because qc_parameter_master is a soft ref. */
  async listResultDetails(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    const rows = (await this.db.execute(sql`
      select d.qc_result_detail_id as "qcResultDetailId",
             d.qc_inspection_id as "qcInspectionId",
             d.qc_parameter_id as "qcParameterId", p.parameter_name as "parameterName",
             d.observed_value as "observedValue", d.observed_text as "observedText",
             d.result as "result", d.status as "status"
        from quality.qc_result_details d
        left join quality.qc_parameter_master p on p.qc_parameter_id = d.qc_parameter_id
       ${query.cursor ? sql`where d.qc_result_detail_id < ${query.cursor}` : sql``}
       order by d.qc_result_detail_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.qcResultDetailId as string);
  }

  async getResultDetail(id: string) {
    return (
      await this.db
        .select()
        .from(qcResultDetails)
        .where(eq(qcResultDetails.qcResultDetailId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── qc attachments (CRUD) ────────────────────────────────────────── */

  async createAttachment(body: CreateQcAttachment, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(qcAttachments)
        .values({
          qcAttachmentId: uuidv7(),
          qcInspectionId: body.qcInspectionId,
          documentId: body.documentId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: qc_attachments');
    return row;
  }

  async listAttachments(query: ListQuery): Promise<Page<typeof qcAttachments.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(qcAttachments)
      .where(query.cursor ? lt(qcAttachments.qcAttachmentId, query.cursor) : undefined)
      .orderBy(desc(qcAttachments.qcAttachmentId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.qcAttachmentId);
  }

  async getAttachment(id: string) {
    return (
      await this.db.select().from(qcAttachments).where(eq(qcAttachments.qcAttachmentId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── flow: disposition ────────────────────────────────────────────── */

  /**
   * POST /v1/qc-inspections/:id/disposition — record the disposition, set the inspection's
   * overall_result, and emit the cross-cluster QC signal. All in one transaction so the
   * event is published iff the disposition + status flip committed.
   */
  async dispose(inspectionId: string, body: DisposeInspection, principal: AuthPrincipal) {
    const inspection = await this.getInspection(inspectionId);
    if (!inspection) throw new NotFoundException(`qc_inspection not found: ${inspectionId}`);

    return this.db.transaction(async (tx) => {
      const disposition = (
        await tx
          .insert(qcDisposition)
          .values({
            qcDispositionId: uuidv7(),
            qcInspectionId: inspectionId,
            dispositionCode: body.dispositionCode,
            dispositionReason: body.dispositionReason ?? null,
            conditions: body.conditions ?? null,
            disposedBy: body.disposedBy ?? principal.userId,
            disposedDt: body.disposedDt ? new Date(body.disposedDt) : new Date(),
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!disposition) throw new Error('insert failed: qc_disposition');

      const updated = (
        await tx
          .update(qcInspections)
          .set({ overallResult: body.dispositionCode, status: body.dispositionCode, updatedBy: principal.userId })
          .where(eq(qcInspections.qcInspectionId, inspectionId))
          .returning()
      )[0];
      if (!updated) throw new Error('update failed: qc_inspections');

      const rmBatchId = updated.rmBatchId ?? inspection.rmBatchId;
      if (body.dispositionCode === 'ACCEPT' && rmBatchId) {
        await recordOutbox(
          tx,
          outbox,
          qualityEvents.qcPassed,
          { qcInspectionId: inspectionId, rmBatchId },
          inspectionId,
        );
      } else if (body.dispositionCode === 'REJECT' && rmBatchId) {
        await recordOutbox(
          tx,
          outbox,
          qualityEvents.qcFailed,
          { qcInspectionId: inspectionId, rmBatchId },
          inspectionId,
        );
      } else if (body.dispositionCode === 'HOLD' && rmBatchId) {
        // HOLD quarantines the batch (not released) and signals QC/owner for a re-test decision.
        await recordOutbox(
          tx,
          outbox,
          qualityEvents.qcHold,
          { qcInspectionId: inspectionId, rmBatchId },
          inspectionId,
        );
      }

      return { inspection: updated, disposition };
    });
  }

  /* ── qc disposition (CRUD reads) ──────────────────────────────────── */

  async listDispositions(query: ListQuery): Promise<Page<typeof qcDisposition.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(qcDisposition)
      .where(query.cursor ? lt(qcDisposition.qcDispositionId, query.cursor) : undefined)
      .orderBy(desc(qcDisposition.qcDispositionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.qcDispositionId);
  }

  async getDisposition(id: string) {
    return (
      await this.db.select().from(qcDisposition).where(eq(qcDisposition.qcDispositionId, id)).limit(1)
    )[0] ?? null;
  }
}

/** Shared cursor pagination — desc(pk), limit+1 → {items, nextCursor}. */
export function paginate<T>(rows: T[], limit: number, pk: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? pk(last) : null;
  return { items, nextCursor };
}
