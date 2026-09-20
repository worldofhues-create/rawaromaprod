/**
 * ClassificationService — CRUD over the material classification chain:
 * MATERIAL_TYPE_MASTER, MATERIAL_CATEGORY_MASTER, MATERIAL_SUBCATEGORY_MASTER,
 * MATERIAL_GROUP. Create stamps status "ACTIVE" + created_by/updated_by from the
 * principal. List is cursor-paginated by descending PK. In-schema parent refs are inserted
 * as plain uuids (the data layer encodes the FKs).
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import {
  MASTERDATA_DB,
  masterdataSchema,
  type MasterdataDb,
} from '../cluster-masterdata.tokens.js';
import type { Page, ListQuery } from '../cluster-masterdata.dtos.js';
import type {
  CreateMaterialCategory,
  CreateMaterialGroup,
  CreateMaterialSubcategory,
  CreateMaterialType,
} from '../cluster-masterdata.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const {
  materialTypeMaster,
  materialCategoryMaster,
  materialSubcategoryMaster,
  materialGroup,
} = masterdataSchema;

@Injectable()
export class ClassificationService {
  constructor(@Inject(MASTERDATA_DB) private readonly db: MasterdataDb) {}

  /* ── material_type_master ───────────────────────────────────────────── */

  async createMaterialType(body: CreateMaterialType, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(materialTypeMaster)
          .values({
            typeCode: body.typeCode,
            typeName: body.typeName,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listMaterialTypes(
    query: ListQuery,
  ): Promise<Page<typeof materialTypeMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialTypeMaster)
      .where(query.cursor ? lt(materialTypeMaster.materialTypeId, query.cursor) : undefined)
      .orderBy(desc(materialTypeMaster.materialTypeId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialTypeId);
  }

  async getMaterialType(id: string) {
    return (
      (
        await this.db
          .select()
          .from(materialTypeMaster)
          .where(eq(materialTypeMaster.materialTypeId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── material_category_master ───────────────────────────────────────── */

  async createMaterialCategory(body: CreateMaterialCategory, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(materialCategoryMaster)
          .values({
            materialTypeId: body.materialTypeId ?? null,
            categoryCode: body.categoryCode,
            categoryName: body.categoryName,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listMaterialCategories(
    query: ListQuery,
  ): Promise<Page<typeof materialCategoryMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialCategoryMaster)
      .where(
        query.cursor
          ? lt(materialCategoryMaster.materialCategoryId, query.cursor)
          : undefined,
      )
      .orderBy(desc(materialCategoryMaster.materialCategoryId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialCategoryId);
  }

  async getMaterialCategory(id: string) {
    return (
      (
        await this.db
          .select()
          .from(materialCategoryMaster)
          .where(eq(materialCategoryMaster.materialCategoryId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── material_subcategory_master ────────────────────────────────────── */

  async createMaterialSubcategory(
    body: CreateMaterialSubcategory,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(materialSubcategoryMaster)
          .values({
            materialCategoryId: body.materialCategoryId ?? null,
            subCategoryCode: body.subCategoryCode,
            subCategoryName: body.subCategoryName,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listMaterialSubcategories(
    query: ListQuery,
  ): Promise<Page<typeof materialSubcategoryMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialSubcategoryMaster)
      .where(
        query.cursor
          ? lt(materialSubcategoryMaster.materialSubcategoryId, query.cursor)
          : undefined,
      )
      .orderBy(desc(materialSubcategoryMaster.materialSubcategoryId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialSubcategoryId);
  }

  async getMaterialSubcategory(id: string) {
    return (
      (
        await this.db
          .select()
          .from(materialSubcategoryMaster)
          .where(eq(materialSubcategoryMaster.materialSubcategoryId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── material_group ─────────────────────────────────────────────────── */

  async createMaterialGroup(body: CreateMaterialGroup, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(materialGroup)
          .values({
            materialSubcategoryId: body.materialSubcategoryId ?? null,
            groupCode: body.groupCode,
            groupName: body.groupName,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listMaterialGroups(
    query: ListQuery,
  ): Promise<Page<typeof materialGroup.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialGroup)
      .where(query.cursor ? lt(materialGroup.materialGroupId, query.cursor) : undefined)
      .orderBy(desc(materialGroup.materialGroupId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialGroupId);
  }

  async getMaterialGroup(id: string) {
    return (
      (
        await this.db
          .select()
          .from(materialGroup)
          .where(eq(materialGroup.materialGroupId, id))
          .limit(1)
      )[0] ?? null
    );
  }
}
