/**
 * MaterialService — CRUD over the material master + its dependents: MATERIAL, RM_ALIAS,
 * MATERIAL_QC_SPECIFICATIONS, MATERIAL_STORAGE_RULES, MATERIAL_AGEING.
 *
 * Two creates carry an outbox event recorded inside the same transaction as the write:
 *   - createMaterial → `masterdata.material.created` {materialId}
 *   - createRmAlias  → `masterdata.alias.created` {rmAliasId, materialId}
 * Create stamps status "ACTIVE" + created_by/updated_by from the principal. numeric →
 * String(n); dates arrive as ISO strings and are stored on date columns as-is. In-schema
 * FKs + cross-schema soft refs are inserted as plain uuids.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import {
  MASTERDATA_DB,
  masterdataSchema,
  type MasterdataDb,
} from '../cluster-masterdata.tokens.js';
import { masterdataEvents } from '../cluster-masterdata.events.js';
import type { Page, ListQuery } from '../cluster-masterdata.dtos.js';
import type {
  CreateMaterial,
  CreateMaterialAgeing,
  CreateMaterialQcSpecification,
  CreateMaterialStorageRule,
  CreateRmAlias,
} from '../cluster-masterdata.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const {
  material,
  rmAlias,
  materialQcSpecifications,
  materialStorageRules,
  materialAgeing,
  outbox,
} = masterdataSchema;

@Injectable()
export class MaterialService {
  constructor(@Inject(MASTERDATA_DB) private readonly db: MasterdataDb) {}

  /* ── material — create emits masterdata.material.created ─────────────── */

  async createMaterial(body: CreateMaterial, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const materialId = uuidv7();
      const row = ensure(
        (
          await tx
            .insert(material)
            .values({
              materialId,
              materialGroupId: body.materialGroupId ?? null,
              materialTypeId: body.materialTypeId ?? null,
              materialCategoryId: body.materialCategoryId ?? null,
              materialCode: body.materialCode,
              materialName: body.materialName,
              uomId: body.uomId ?? null,
              description: body.description ?? null,
              scientificName: body.scientificName ?? null,
              density: body.density != null ? String(body.density) : null,
              casNumber: body.casNumber ?? null,
              shelfLifeDays: body.shelfLifeDays ?? null,
              reorderLevel: body.reorderLevel != null ? String(body.reorderLevel) : null,
              minStock: body.minStock != null ? String(body.minStock) : null,
              maxStock: body.maxStock != null ? String(body.maxStock) : null,
              qcRequired: body.qcRequired ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      await recordOutbox(
        tx,
        outbox,
        masterdataEvents.materialCreated,
        { materialId },
        materialId,
      );

      return row;
    });
  }

  async listMaterials(query: ListQuery): Promise<Page<typeof material.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(material)
      .where(query.cursor ? lt(material.materialId, query.cursor) : undefined)
      .orderBy(desc(material.materialId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialId);
  }

  async getMaterial(id: string) {
    return (
      (await this.db.select().from(material).where(eq(material.materialId, id)).limit(1))[0] ??
      null
    );
  }

  /* ── rm_alias — create emits masterdata.alias.created ───────────────── */

  async createRmAlias(body: CreateRmAlias, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const rmAliasId = uuidv7();
      const row = ensure(
        (
          await tx
            .insert(rmAlias)
            .values({
              rmAliasId,
              materialId: body.materialId,
              aliasName: body.aliasName,
              aliasType: body.aliasType ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      await recordOutbox(
        tx,
        outbox,
        masterdataEvents.aliasCreated,
        { rmAliasId, materialId: body.materialId },
        rmAliasId,
      );

      return row;
    });
  }

  async listRmAliases(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    const rows = (await this.db.execute(sql`
      select a.rm_alias_id as "rmAliasId", a.material_id as "materialId",
             m.material_code as "materialCode", m.material_name as "materialName",
             a.alias_name as "aliasName", a.alias_type as "aliasType", a.status as "status"
        from masterdata.rm_alias a
        left join masterdata.material m on m.material_id = a.material_id
       ${query.cursor ? sql`where a.rm_alias_id < ${query.cursor}` : sql``}
       order by a.rm_alias_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.rmAliasId as string);
  }

  async getRmAlias(id: string) {
    return (
      (await this.db.select().from(rmAlias).where(eq(rmAlias.rmAliasId, id)).limit(1))[0] ??
      null
    );
  }

  /* ── material_qc_specifications ─────────────────────────────────────── */

  async createMaterialQcSpecification(
    body: CreateMaterialQcSpecification,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(materialQcSpecifications)
          .values({
            materialId: body.materialId,
            qcParameterId: body.qcParameterId ?? null,
            minValue: body.minValue != null ? String(body.minValue) : null,
            maxValue: body.maxValue != null ? String(body.maxValue) : null,
            targetValue: body.targetValue != null ? String(body.targetValue) : null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listMaterialQcSpecifications(
    query: ListQuery,
  ): Promise<Page<Record<string, unknown>>> {
    const rows = (await this.db.execute(sql`
      select s.material_qc_specification_id as "materialQcSpecificationId",
             s.material_id as "materialId", m.material_code as "materialCode", m.material_name as "materialName",
             s.qc_parameter_id as "qcParameterId", p.parameter_name as "parameterName",
             s.min_value as "minValue", s.max_value as "maxValue", s.target_value as "targetValue", s.status as "status"
        from masterdata.material_qc_specifications s
        left join masterdata.material m on m.material_id = s.material_id
        left join quality.qc_parameter_master p on p.qc_parameter_id = s.qc_parameter_id
       ${query.cursor ? sql`where s.material_qc_specification_id < ${query.cursor}` : sql``}
       order by s.material_qc_specification_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.materialQcSpecificationId as string);
  }

  async getMaterialQcSpecification(id: string) {
    return (
      (
        await this.db
          .select()
          .from(materialQcSpecifications)
          .where(eq(materialQcSpecifications.materialQcSpecificationId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── material_storage_rules ─────────────────────────────────────────── */

  async createMaterialStorageRule(
    body: CreateMaterialStorageRule,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(materialStorageRules)
          .values({
            materialId: body.materialId,
            storageLocationTypeId: body.storageLocationTypeId ?? null,
            minTemperature: body.minTemperature ?? null,
            maxTemperature: body.maxTemperature ?? null,
            storageCondition: body.storageCondition ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listMaterialStorageRules(
    query: ListQuery,
  ): Promise<Page<Record<string, unknown>>> {
    const rows = (await this.db.execute(sql`
      select r.material_storage_rule_id as "materialStorageRuleId",
             r.material_id as "materialId", m.material_code as "materialCode", m.material_name as "materialName",
             r.min_temperature as "minTemperature", r.max_temperature as "maxTemperature",
             r.storage_condition as "storageCondition", r.status as "status"
        from masterdata.material_storage_rules r
        left join masterdata.material m on m.material_id = r.material_id
       ${query.cursor ? sql`where r.material_storage_rule_id < ${query.cursor}` : sql``}
       order by r.material_storage_rule_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.materialStorageRuleId as string);
  }

  async getMaterialStorageRule(id: string) {
    return (
      (
        await this.db
          .select()
          .from(materialStorageRules)
          .where(eq(materialStorageRules.materialStorageRuleId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── material_ageing ────────────────────────────────────────────────── */

  async createMaterialAgeing(body: CreateMaterialAgeing, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(materialAgeing)
          .values({
            materialId: body.materialId,
            inventoryBatchId: body.inventoryBatchId ?? null,
            storageLocationId: body.storageLocationId ?? null,
            quantityOnHand:
              body.quantityOnHand != null ? String(body.quantityOnHand) : null,
            uomId: body.uomId ?? null,
            receiptDate: body.receiptDate ?? null,
            snapshotDate: body.snapshotDate ?? null,
            ageingDays: body.ageingDays ?? null,
            ageingBucket: body.ageingBucket ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listMaterialAgeings(
    query: ListQuery,
  ): Promise<Page<typeof materialAgeing.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(materialAgeing)
      .where(query.cursor ? lt(materialAgeing.materialAgeingId, query.cursor) : undefined)
      .orderBy(desc(materialAgeing.materialAgeingId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.materialAgeingId);
  }

  async getMaterialAgeing(id: string) {
    return (
      (
        await this.db
          .select()
          .from(materialAgeing)
          .where(eq(materialAgeing.materialAgeingId, id))
          .limit(1)
      )[0] ?? null
    );
  }
}
