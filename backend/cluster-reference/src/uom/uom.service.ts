/**
 * UomService — CRUD over the uom + brand reference masters: UOM_TYPE, UOM, UOM_CONVERSION,
 * BRAND. Create stamps status "ACTIVE" + created_by/updated_by from the principal; numeric
 * conversion_factor is stringified at insert. List is cursor-paginated by descending PK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { REFERENCE_DB, referenceSchema, type ReferenceDb } from '../reference.tokens.js';
import type {
  CreateBrand,
  CreateUom,
  CreateUomConversion,
  CreateUomType,
  ListQuery,
} from '../reference.dtos.js';

const { uomTypeMaster, uomMaster, uomConversionMaster, brandMaster } = referenceSchema;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class UomService {
  constructor(@Inject(REFERENCE_DB) private readonly db: ReferenceDb) {}

  /* ── uom type ─────────────────────────────────────────────────────── */

  async createUomType(body: CreateUomType, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(uomTypeMaster)
        .values({
          typeCode: body.typeCode,
          typeName: body.typeName,
          description: body.description ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: uom_type_master');
    return row;
  }

  async listUomTypes(query: ListQuery): Promise<Page<typeof uomTypeMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(uomTypeMaster)
      .where(query.cursor ? lt(uomTypeMaster.uomTypeId, query.cursor) : undefined)
      .orderBy(desc(uomTypeMaster.uomTypeId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.uomTypeId);
  }

  async getUomType(id: string) {
    return (
      await this.db.select().from(uomTypeMaster).where(eq(uomTypeMaster.uomTypeId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── uom ──────────────────────────────────────────────────────────── */

  async createUom(body: CreateUom, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(uomMaster)
        .values({
          uomCode: body.uomCode,
          uomName: body.uomName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: uom_master');
    return row;
  }

  async listUoms(query: ListQuery): Promise<Page<typeof uomMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(uomMaster)
      .where(query.cursor ? lt(uomMaster.uomId, query.cursor) : undefined)
      .orderBy(desc(uomMaster.uomId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.uomId);
  }

  async getUom(id: string) {
    return (await this.db.select().from(uomMaster).where(eq(uomMaster.uomId, id)).limit(1))[0] ?? null;
  }

  /* ── uom conversion ───────────────────────────────────────────────── */

  async createUomConversion(body: CreateUomConversion, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(uomConversionMaster)
        .values({
          uomTypeId: body.uomTypeId ?? null,
          fromUomId: body.fromUomId ?? null,
          toUomId: body.toUomId ?? null,
          conversionFactor: String(body.conversionFactor),
          isActive: body.isActive ?? true,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: uom_conversion_master');
    return row;
  }

  async listUomConversions(
    query: ListQuery,
  ): Promise<Page<typeof uomConversionMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(uomConversionMaster)
      .where(query.cursor ? lt(uomConversionMaster.uomConversionId, query.cursor) : undefined)
      .orderBy(desc(uomConversionMaster.uomConversionId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.uomConversionId);
  }

  async getUomConversion(id: string) {
    return (
      await this.db
        .select()
        .from(uomConversionMaster)
        .where(eq(uomConversionMaster.uomConversionId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── brand ────────────────────────────────────────────────────────── */

  async createBrand(body: CreateBrand, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(brandMaster)
        .values({
          brandCode: body.brandCode,
          brandName: body.brandName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: brand_master');
    return row;
  }

  async listBrands(query: ListQuery): Promise<Page<typeof brandMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(brandMaster)
      .where(query.cursor ? lt(brandMaster.brandId, query.cursor) : undefined)
      .orderBy(desc(brandMaster.brandId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.brandId);
  }

  async getBrand(id: string) {
    return (
      await this.db.select().from(brandMaster).where(eq(brandMaster.brandId, id)).limit(1)
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
