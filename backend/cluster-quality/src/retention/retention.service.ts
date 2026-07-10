/**
 * RetentionService — CRUD over QC_SAMPLE_RETENTION. Create stamps status "ACTIVE" +
 * created_by/updated_by from the principal; sample_qty is stringified at insert; ISO
 * timestamps → Date. qc_inspection_id and all other refs are dict-soft / cross-schema (plain
 * uuid). List is cursor-paginated by descending PK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import type { AuthPrincipal } from '@core/backend-kernel';
import { QUALITY_DB, qualitySchema, type QualityDb } from '../quality.tokens.js';
import type { CreateQcSampleRetention, ListQuery } from '../quality.dtos.js';

const { qcSampleRetention } = qualitySchema;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class RetentionService {
  constructor(@Inject(QUALITY_DB) private readonly db: QualityDb) {}

  async createSampleRetention(body: CreateQcSampleRetention, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(qcSampleRetention)
        .values({
          qcSampleRetentionId: uuidv7(),
          qcInspectionId: body.qcInspectionId ?? null,
          rmBatchId: body.rmBatchId ?? null,
          oilBatchId: body.oilBatchId ?? null,
          sampleCode: body.sampleCode,
          sampleQty: body.sampleQty === undefined ? null : String(body.sampleQty),
          uomId: body.uomId ?? null,
          retentionLocationId: body.retentionLocationId ?? null,
          retainedDt: body.retainedDt ? new Date(body.retainedDt) : new Date(),
          // QC-02: stamp the QC user who retained the sample. Audit LOW: the actor is the
          // authenticated user, never a spoofable body field.
          retainedBy: principal.userId,
          retentionExpiryDt: body.retentionExpiryDt ? new Date(body.retentionExpiryDt) : null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: qc_sample_retention');
    return row;
  }

  async listSampleRetentions(
    query: ListQuery,
  ): Promise<Page<typeof qcSampleRetention.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(qcSampleRetention)
      .where(query.cursor ? lt(qcSampleRetention.qcSampleRetentionId, query.cursor) : undefined)
      .orderBy(desc(qcSampleRetention.qcSampleRetentionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.qcSampleRetentionId);
  }

  async getSampleRetention(id: string) {
    return (
      await this.db
        .select()
        .from(qcSampleRetention)
        .where(eq(qcSampleRetention.qcSampleRetentionId, id))
        .limit(1)
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
