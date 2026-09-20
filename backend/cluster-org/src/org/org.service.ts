/**
 * OrgService — CRUD over the organization tables (org group/type/org/relationship,
 * business unit). Foundation masters: create stamps created_by/updated_by from the
 * principal and defaults status to "ACTIVE"; list is cursor-paginated (desc PK, limit+1).
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { ORG_DB, orgSchema, type OrgDb } from '../cluster-org.tokens.js';
import type { ListQuery, Page } from '../cluster-org.dtos.js';
import type {
  CreateBusinessUnitBody,
  CreateOrgBody,
  CreateOrgGroupBody,
  CreateOrgRelationshipBody,
  CreateOrgTypeBody,
} from './org.dtos.js';

const {
  orgGroupMaster,
  orgTypeMaster,
  orgMaster,
  orgRelationship,
  businessUnitMaster,
} = orgSchema;

type OrgGroupRow = typeof orgGroupMaster.$inferSelect;
type OrgTypeRow = typeof orgTypeMaster.$inferSelect;
type OrgRow = typeof orgMaster.$inferSelect;
type OrgRelationshipRow = typeof orgRelationship.$inferSelect;
type BusinessUnitRow = typeof businessUnitMaster.$inferSelect;

@Injectable()
export class OrgService {
  constructor(@Inject(ORG_DB) private readonly db: OrgDb) {}

  // ── org_group_master ──────────────────────────────────────────────────────
  async createOrgGroup(
    body: CreateOrgGroupBody,
    principal: AuthPrincipal,
  ): Promise<OrgGroupRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(orgGroupMaster)
      .values({
        orgGroupCode: body.orgGroupCode,
        orgGroupName: body.orgGroupName,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listOrgGroups(query: ListQuery): Promise<Page<OrgGroupRow>> {
    const rows = await this.db
      .select()
      .from(orgGroupMaster)
      .where(query.cursor ? lt(orgGroupMaster.orgGroupId, query.cursor) : undefined)
      .orderBy(desc(orgGroupMaster.orgGroupId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.orgGroupId);
  }

  async getOrgGroupById(id: string): Promise<OrgGroupRow | null> {
    const rows = await this.db
      .select()
      .from(orgGroupMaster)
      .where(eq(orgGroupMaster.orgGroupId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── org_type_master ───────────────────────────────────────────────────────
  async createOrgType(
    body: CreateOrgTypeBody,
    principal: AuthPrincipal,
  ): Promise<OrgTypeRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(orgTypeMaster)
      .values({
        orgTypeCode: body.orgTypeCode,
        orgTypeName: body.orgTypeName,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listOrgTypes(query: ListQuery): Promise<Page<OrgTypeRow>> {
    const rows = await this.db
      .select()
      .from(orgTypeMaster)
      .where(query.cursor ? lt(orgTypeMaster.orgTypeId, query.cursor) : undefined)
      .orderBy(desc(orgTypeMaster.orgTypeId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.orgTypeId);
  }

  async getOrgTypeById(id: string): Promise<OrgTypeRow | null> {
    const rows = await this.db
      .select()
      .from(orgTypeMaster)
      .where(eq(orgTypeMaster.orgTypeId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── org_master ────────────────────────────────────────────────────────────
  async createOrg(body: CreateOrgBody, principal: AuthPrincipal): Promise<OrgRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(orgMaster)
      .values({
        orgGroupId: body.orgGroupId,
        orgTypeId: body.orgTypeId,
        organizationCode: body.organizationCode,
        organizationName: body.organizationName,
        registrationCountryId: body.registrationCountryId,
        baseCurrencyId: body.baseCurrencyId,
        defaultTimezoneId: body.defaultTimezoneId,
        defaultLanguageId: body.defaultLanguageId,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listOrgs(query: ListQuery): Promise<Page<OrgRow>> {
    const rows = await this.db
      .select()
      .from(orgMaster)
      .where(query.cursor ? lt(orgMaster.organizationId, query.cursor) : undefined)
      .orderBy(desc(orgMaster.organizationId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.organizationId);
  }

  async getOrgById(id: string): Promise<OrgRow | null> {
    const rows = await this.db
      .select()
      .from(orgMaster)
      .where(eq(orgMaster.organizationId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── org_relationship ──────────────────────────────────────────────────────
  async createOrgRelationship(
    body: CreateOrgRelationshipBody,
    principal: AuthPrincipal,
  ): Promise<OrgRelationshipRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(orgRelationship)
      .values({
        organizationId: body.organizationId,
        relatedOrganizationId: body.relatedOrganizationId,
        relationshipType: body.relationshipType,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listOrgRelationships(query: ListQuery): Promise<Page<OrgRelationshipRow>> {
    const rows = await this.db
      .select()
      .from(orgRelationship)
      .where(
        query.cursor ? lt(orgRelationship.orgRelationshipId, query.cursor) : undefined,
      )
      .orderBy(desc(orgRelationship.orgRelationshipId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.orgRelationshipId);
  }

  async getOrgRelationshipById(id: string): Promise<OrgRelationshipRow | null> {
    const rows = await this.db
      .select()
      .from(orgRelationship)
      .where(eq(orgRelationship.orgRelationshipId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── business_unit_master ──────────────────────────────────────────────────
  async createBusinessUnit(
    body: CreateBusinessUnitBody,
    principal: AuthPrincipal,
  ): Promise<BusinessUnitRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(businessUnitMaster)
      .values({
        organizationId: body.organizationId,
        parentBusinessUnitId: body.parentBusinessUnitId,
        businessUnitCode: body.businessUnitCode,
        businessUnitName: body.businessUnitName,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listBusinessUnits(query: ListQuery): Promise<Page<BusinessUnitRow>> {
    const rows = await this.db
      .select()
      .from(businessUnitMaster)
      .where(
        query.cursor ? lt(businessUnitMaster.businessUnitId, query.cursor) : undefined,
      )
      .orderBy(desc(businessUnitMaster.businessUnitId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.businessUnitId);
  }

  async getBusinessUnitById(id: string): Promise<BusinessUnitRow | null> {
    const rows = await this.db
      .select()
      .from(businessUnitMaster)
      .where(eq(businessUnitMaster.businessUnitId, id))
      .limit(1);
    return rows[0] ?? null;
  }
}

/** Slice the `limit+1` window into a page + the next cursor (the last kept row's id). */
function paginate<T>(rows: T[], limit: number, idOf: (row: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit && items.length > 0 ? idOf(items[items.length - 1]!) : null;
  return { items, nextCursor };
}

/** Guard an INSERT … RETURNING result that the type system marks optional. */
function ensure<T>(row: T | undefined): T {
  if (!row) throw new Error('insert returned no row');
  return row;
}
