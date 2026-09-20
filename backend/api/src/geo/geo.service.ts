/**
 * GeoService — CRUD over the geographic hierarchy below Country (platform.geo_region_types +
 * platform.geo_regions). The dictionary shipped these tables empty with no route, so the address
 * masters had only a flat Country list. geo_region_types defines the levels (State, District,
 * City, Locality, Pincode …); geo_regions is the self-referential tree (parent_id) of actual
 * places. These tables use their own convention (id/is_active/created_at, no created_by), so they
 * don't fit the generic edit registry — hence this small raw-SQL module. Reads are auth-gated by
 * the edge guard; writes require platform:geo_location_master:write (checked here, like EditService).
 */
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

const WRITE_PERM = 'platform:geo_location_master:write';

interface RegionTypeBody {
  key?: string;
  name?: string;
  displayOrder?: number | null;
  typicalParent?: string | null;
}
interface RegionBody {
  typeKey?: string;
  parentId?: string | null;
  name?: string;
  code?: string | null;
  isActive?: boolean | null;
}

@Injectable()
export class GeoService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  private assertWrite(p: AuthPrincipal): void {
    if (!(p.permissions || []).includes(WRITE_PERM)) {
      throw new ForbiddenException(`Missing permission ${WRITE_PERM}`);
    }
  }

  /* ── region types (the levels) ──────────────────────────────────────── */

  async listRegionTypes() {
    const items = await this.sql`
      select key, name, display_order as "displayOrder", typical_parent as "typicalParent"
        from platform.geo_region_types
       order by display_order asc nulls last, name asc`;
    return { items, nextCursor: null };
  }

  async createRegionType(body: RegionTypeBody, principal: AuthPrincipal) {
    this.assertWrite(principal);
    if (!body.key || !body.name) throw new BadRequestException('key and name are required');
    const rows = (await this.sql`
      insert into platform.geo_region_types (key, name, display_order, typical_parent)
      values (${body.key}, ${body.name}, ${body.displayOrder ?? null}, ${body.typicalParent ?? null})
      on conflict (key) do update set name = excluded.name,
        display_order = excluded.display_order, typical_parent = excluded.typical_parent
      returning key, name, display_order as "displayOrder", typical_parent as "typicalParent"`) as Array<Record<string, unknown>>;
    return rows[0];
  }

  /* ── regions (the tree of places) ───────────────────────────────────── */

  async listRegions(typeKey?: string, limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select r.id, r.type_key as "typeKey", t.name as "typeName", r.parent_id as "parentId",
             p.name as "parentName", r.name, r.code, r.is_active as "isActive"
        from platform.geo_regions r
        left join platform.geo_region_types t on t.key = r.type_key
        left join platform.geo_regions p on p.id = r.parent_id
       ${typeKey ? this.sql`where r.type_key = ${typeKey}` : this.sql``}
       order by t.display_order asc nulls last, r.name asc
       limit ${lim}`;
    return { items, nextCursor: null };
  }

  async createRegion(body: RegionBody, principal: AuthPrincipal) {
    this.assertWrite(principal);
    if (!body.typeKey || !body.name) throw new BadRequestException('typeKey and name are required');
    const rows = (await this.sql`
      insert into platform.geo_regions (id, type_key, parent_id, name, code, is_active, created_at, updated_at)
      values (${randomUUID()}, ${body.typeKey}, ${body.parentId ?? null}, ${body.name}, ${body.code ?? null}, true, now(), now())
      returning id, type_key as "typeKey", parent_id as "parentId", name, code, is_active as "isActive"`) as Array<Record<string, unknown>>;
    return rows[0];
  }

  async updateRegion(id: string, body: RegionBody, principal: AuthPrincipal) {
    this.assertWrite(principal);
    const rows = (await this.sql`
      update platform.geo_regions set
        name = coalesce(${body.name ?? null}, name),
        code = coalesce(${body.code ?? null}, code),
        type_key = coalesce(${body.typeKey ?? null}, type_key),
        parent_id = coalesce(${body.parentId ?? null}, parent_id),
        is_active = coalesce(${body.isActive ?? null}, is_active),
        updated_at = now()
      where id = ${id}
      returning id, type_key as "typeKey", parent_id as "parentId", name, code, is_active as "isActive"`) as Array<Record<string, unknown>>;
    if (!rows.length) throw new BadRequestException(`geo region ${id} not found`);
    return rows[0];
  }
}
