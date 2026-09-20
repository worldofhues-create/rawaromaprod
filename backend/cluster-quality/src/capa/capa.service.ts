/**
 * CapaService — simple table-only CRUD over QC_CAPA (the CAPA workflow itself is Phase-1B).
 * Create stamps status "ACTIVE" + created_by/updated_by from the principal; ISO timestamps →
 * Date. qc_inspection_id / assigned_to / verified_by are dict-soft refs (plain uuid). List is
 * cursor-paginated by descending PK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import type { AuthPrincipal } from '@core/backend-kernel';
import { QUALITY_DB, qualitySchema, type QualityDb } from '../quality.tokens.js';
import type { CreateQcCapa, ListQuery } from '../quality.dtos.js';

const { qcCapa } = qualitySchema;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class CapaService {
  constructor(@Inject(QUALITY_DB) private readonly db: QualityDb) {}

  async createCapa(body: CreateQcCapa, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(qcCapa)
        .values({
          qcCapaId: uuidv7(),
          qcInspectionId: body.qcInspectionId ?? null,
          capaCode: body.capaCode,
          capaType: body.capaType ?? null,
          description: body.description ?? null,
          rootCause: body.rootCause ?? null,
          actionPlan: body.actionPlan ?? null,
          assignedTo: body.assignedTo ?? null,
          dueDt: body.dueDt ? new Date(body.dueDt) : null,
          closedDt: body.closedDt ? new Date(body.closedDt) : null,
          closureEvidence: body.closureEvidence ?? null,
          verifiedBy: body.verifiedBy ?? null,
          verifiedDt: body.verifiedDt ? new Date(body.verifiedDt) : null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: qc_capa');
    return row;
  }

  async listCapas(query: ListQuery): Promise<Page<typeof qcCapa.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(qcCapa)
      .where(query.cursor ? lt(qcCapa.qcCapaId, query.cursor) : undefined)
      .orderBy(desc(qcCapa.qcCapaId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.qcCapaId);
  }

  async getCapa(id: string) {
    return (await this.db.select().from(qcCapa).where(eq(qcCapa.qcCapaId, id)).limit(1))[0] ?? null;
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
