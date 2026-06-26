/**
 * CatalogService — the non-secret formula masters + the read-only logs: FORMULA_TYPE_MASTER,
 * FORMULA_ACCESS_POLICY, FORMULA_DOCUMENT_MAPPING (create + list + get), and read access to
 * FORMULA_CHANGE_LOG / FORMULA_EVENT_HIST (append-only, written by the flow services). None of
 * these touch ciphertext — they describe the formula, not its recipe.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, lt, eq } from 'drizzle-orm';
import { type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { FORMULA_DB, formulaSchema, type FormulaDb } from '../formula.tokens.js';
import { paginate, type Page } from '../formulas/formulas.service.js';
import type {
  CreateAccessPolicy,
  CreateDocumentMapping,
  CreateFormulaType,
  ListQuery,
} from '../formula.dtos.js';

const {
  formulaTypeMaster,
  formulaAccessPolicy,
  formulaDocumentMapping,
  formulaChangeLog,
  formulaEventHist,
} = formulaSchema;

@Injectable()
export class CatalogService {
  constructor(@Inject(FORMULA_DB) private readonly db: FormulaDb) {}

  /* ── formula type master ──────────────────────────────────────────── */

  async createType(body: CreateFormulaType, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(formulaTypeMaster)
        .values({
          formulaTypeId: uuidv7(),
          typeCode: body.typeCode,
          typeName: body.typeName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: formula_type_master');
    return row;
  }

  async listTypes(query: ListQuery): Promise<Page<typeof formulaTypeMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaTypeMaster)
      .where(query.cursor ? lt(formulaTypeMaster.formulaTypeId, query.cursor) : undefined)
      .orderBy(desc(formulaTypeMaster.formulaTypeId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaTypeId);
  }

  async getType(id: string) {
    return (
      await this.db
        .select()
        .from(formulaTypeMaster)
        .where(eq(formulaTypeMaster.formulaTypeId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── access policy ────────────────────────────────────────────────── */

  async createAccessPolicy(body: CreateAccessPolicy, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(formulaAccessPolicy)
        .values({
          formulaAccessPolicyId: uuidv7(),
          formulaId: body.formulaId,
          roleId: body.roleId ?? null,
          userId: body.userId ?? null,
          accessLevel: body.accessLevel ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: formula_access_policy');
    return row;
  }

  async listAccessPolicies(query: ListQuery): Promise<Page<typeof formulaAccessPolicy.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaAccessPolicy)
      .where(query.cursor ? lt(formulaAccessPolicy.formulaAccessPolicyId, query.cursor) : undefined)
      .orderBy(desc(formulaAccessPolicy.formulaAccessPolicyId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaAccessPolicyId);
  }

  /* ── document mapping ─────────────────────────────────────────────── */

  async createDocumentMapping(body: CreateDocumentMapping, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(formulaDocumentMapping)
        .values({
          formulaDocumentMappingId: uuidv7(),
          formulaId: body.formulaId,
          formulaVersionId: body.formulaVersionId ?? null,
          documentTypeId: body.documentTypeId ?? null,
          documentId: body.documentId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: formula_document_mapping');
    return row;
  }

  async listDocumentMappings(
    query: ListQuery,
  ): Promise<Page<typeof formulaDocumentMapping.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaDocumentMapping)
      .where(
        query.cursor
          ? lt(formulaDocumentMapping.formulaDocumentMappingId, query.cursor)
          : undefined,
      )
      .orderBy(desc(formulaDocumentMapping.formulaDocumentMappingId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaDocumentMappingId);
  }

  /* ── read-only logs ───────────────────────────────────────────────── */

  async listChangeLog(query: ListQuery): Promise<Page<typeof formulaChangeLog.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaChangeLog)
      .where(query.cursor ? lt(formulaChangeLog.formulaChangeLogId, query.cursor) : undefined)
      .orderBy(desc(formulaChangeLog.formulaChangeLogId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaChangeLogId);
  }

  async listEventHist(query: ListQuery): Promise<Page<typeof formulaEventHist.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaEventHist)
      .where(query.cursor ? lt(formulaEventHist.formulaEventHistId, query.cursor) : undefined)
      .orderBy(desc(formulaEventHist.formulaEventHistId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaEventHistId);
  }
}
