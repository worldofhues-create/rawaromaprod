/**
 * DocumentService — CRUD over the document reference masters: DOCUMENT_TYPE and DOCUMENT.
 * Create stamps status "ACTIVE" + created_by/updated_by from the principal; uploaded_dt is
 * parsed from ISO. List is cursor-paginated by descending PK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { REFERENCE_DB, referenceSchema, type ReferenceDb } from '../reference.tokens.js';
import type { CreateDocument, CreateDocumentType, ListQuery } from '../reference.dtos.js';

const { documentTypeMaster, documentMaster } = referenceSchema;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class DocumentService {
  constructor(@Inject(REFERENCE_DB) private readonly db: ReferenceDb) {}

  /* ── document type ────────────────────────────────────────────────── */

  async createDocumentType(body: CreateDocumentType, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(documentTypeMaster)
        .values({
          documentTypeCode: body.documentTypeCode,
          documentTypeName: body.documentTypeName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: document_type_master');
    return row;
  }

  async listDocumentTypes(
    query: ListQuery,
  ): Promise<Page<typeof documentTypeMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(documentTypeMaster)
      .where(query.cursor ? lt(documentTypeMaster.documentTypeId, query.cursor) : undefined)
      .orderBy(desc(documentTypeMaster.documentTypeId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.documentTypeId);
  }

  async getDocumentType(id: string) {
    return (
      await this.db
        .select()
        .from(documentTypeMaster)
        .where(eq(documentTypeMaster.documentTypeId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── document ─────────────────────────────────────────────────────── */

  async createDocument(body: CreateDocument, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(documentMaster)
        .values({
          documentTypeId: body.documentTypeId ?? null,
          fileName: body.fileName,
          filePath: body.filePath,
          uploadedDt: body.uploadedDt ? new Date(body.uploadedDt) : null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: document_master');
    return row;
  }

  async listDocuments(query: ListQuery): Promise<Page<typeof documentMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(documentMaster)
      .where(query.cursor ? lt(documentMaster.documentId, query.cursor) : undefined)
      .orderBy(desc(documentMaster.documentId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.documentId);
  }

  async getDocument(id: string) {
    return (
      await this.db.select().from(documentMaster).where(eq(documentMaster.documentId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── shared cursor pagination ─────────────────────────────────────── */

  private paginate<T>(rows: T[], limit: number, pk: (row: T) => string): Page<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? pk(last) : null;
    return { items, nextCursor };
  }
}
