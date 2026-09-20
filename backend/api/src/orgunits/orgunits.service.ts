/**
 * OrgUnitsService — Organization Management (scope-freeze M01). iam.organizations shipped with no
 * route; it uses the id/created_at convention (not dict metaColumns), so like the geo module it
 * needs its own small raw-SQL CRUD rather than the generic edit registry. Multi-company is the
 * `type` column (GROUP / COMPANY / SUBSIDIARY); company registration + tax are rera_no + gstin.
 * Reads are auth-only (edge guard); writes require iam:business_unit_master:write (the org-admin
 * capability the owner/admin hold), checked here.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

const WRITE_PERM = 'iam:business_unit_master:write';

@Injectable()
export class OrgUnitsService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  private assertWrite(p: AuthPrincipal): void {
    if (!(p.permissions || []).includes(WRITE_PERM)) {
      throw new ForbiddenException(`Missing permission ${WRITE_PERM}`);
    }
  }

  async list(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select id, type, name, rera_no as "reraNo", gstin, status
        from iam.organizations
       order by name asc
       limit ${lim}`;
    return { items, nextCursor: null };
  }

  async create(body: Record<string, unknown>, principal: AuthPrincipal) {
    this.assertWrite(principal);
    const g = (k: string): string | null => {
      const v = body[k];
      return v == null || v === '' ? null : String(v);
    };
    if (!g('name')) throw new BadRequestException('name is required');
    const rows = (await this.sql`
      insert into iam.organizations (id, type, name, rera_no, gstin, status, created_at, updated_at, created_by, updated_by)
      values (${randomUUID()}, ${g('type') ?? 'COMPANY'}, ${g('name')}, ${g('reraNo')}, ${g('gstin')},
              'ACTIVE', now(), now(), ${principal.userId}, ${principal.userId})
      returning id, type, name, rera_no as "reraNo", gstin, status`) as Array<Record<string, unknown>>;
    return rows[0];
  }

  async update(id: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    this.assertWrite(principal);
    const g = (k: string): string | null => {
      const v = body[k];
      return v == null || v === '' ? null : String(v);
    };
    const rows = (await this.sql`
      update iam.organizations set
        type = coalesce(${g('type')}, type),
        name = coalesce(${g('name')}, name),
        rera_no = coalesce(${g('reraNo')}, rera_no),
        gstin = coalesce(${g('gstin')}, gstin),
        status = coalesce(${g('status')}, status),
        updated_at = now(), updated_by = ${principal.userId}
      where id = ${id}
      returning id, type, name, rera_no as "reraNo", gstin, status`) as Array<Record<string, unknown>>;
    if (!rows.length) throw new BadRequestException(`organization ${id} not found`);
    return rows[0];
  }
}
