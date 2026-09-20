/**
 * CatalogService — CRUD over the QC parameter catalog master: QC_PARAMETER_MASTER. Create
 * stamps status "ACTIVE" + created_by/updated_by from the principal; uom_id is a cross-schema
 * soft ref (plain uuid). List is cursor-paginated by descending PK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { QUALITY_DB, qualitySchema, type QualityDb } from '../quality.tokens.js';
import type { CreateQcParameter, ListQuery } from '../quality.dtos.js';

const { qcParameterMaster } = qualitySchema;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class CatalogService {
  constructor(@Inject(QUALITY_DB) private readonly db: QualityDb) {}

  async createQcParameter(body: CreateQcParameter, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(qcParameterMaster)
        .values({
          parameterCode: body.parameterCode,
          parameterName: body.parameterName,
          uomId: body.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: qc_parameter_master');
    return row;
  }

  async listQcParameters(
    query: ListQuery,
  ): Promise<Page<typeof qcParameterMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(qcParameterMaster)
      .where(query.cursor ? lt(qcParameterMaster.qcParameterId, query.cursor) : undefined)
      .orderBy(desc(qcParameterMaster.qcParameterId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.qcParameterId);
  }

  async getQcParameter(id: string) {
    return (
      await this.db
        .select()
        .from(qcParameterMaster)
        .where(eq(qcParameterMaster.qcParameterId, id))
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
