/**
 * DocumentsService — M01 Document Management (the base document_master is just a filename label).
 * Full registry: title, type, entity mapping (vendor/material/formula/customer), a source_url link
 * (binary bytes are out of Phase-1 scope on the $0 stack), version history via supersedes_id, and
 * expiry_date with a live days-to-expiry so licences/COAs can be chased before they lapse. Creating
 * a version with supersedesId flips the prior doc to SUPERSEDED. Raw SQL over the shared PG_CLIENT.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

const SELECT = `select document_registry_id as "documentRegistryId", title, document_type as "documentType",
  entity_type as "entityType", entity_id as "entityId", reference_no as "referenceNo",
  source_url as "sourceUrl", file_name as "fileName", version, supersedes_id as "supersedesId",
  issue_date as "issueDate", expiry_date as "expiryDate",
  case when expiry_date is not null then (expiry_date - current_date) end as "daysToExpiry",
  notes, status, created_dt as "createdDt" from platform.document_registry`;

@Injectable()
export class DocumentsService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async list(opts: { limit?: number; entityType?: string; entityId?: string }) {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 200);
    const conds: string[] = [];
    const params: string[] = [];
    if (opts.entityType) { params.push(opts.entityType); conds.push(`entity_type = $${params.length}`); }
    if (opts.entityId) { params.push(opts.entityId); conds.push(`entity_id = $${params.length}`); }
    const where = conds.length ? `where ${conds.join(' and ')}` : '';
    const rows = await this.sql.unsafe(
      `${SELECT} ${where} order by expiry_date asc nulls last, created_dt desc limit ${limit}`,
      params,
    );
    return { items: rows, nextCursor: null };
  }

  async get(id: string) {
    const rows = await this.sql.unsafe(`${SELECT} where document_registry_id = $1 limit 1`, [id]);
    if (!rows.length) throw new NotFoundException('document not found');
    return rows[0];
  }

  async create(body: Record<string, unknown>, principal: AuthPrincipal) {
    const id = randomUUID();
    const s = (v: unknown) => (v == null || v === '' ? null : String(v));
    const supersedesId = s(body.supersedesId);
    const version = supersedesId ? await this.nextVersion(supersedesId) : Number(body.version) || 1;
    await this.sql`
      insert into platform.document_registry
        (document_registry_id, title, document_type, entity_type, entity_id, reference_no,
         source_url, file_name, version, supersedes_id, issue_date, expiry_date, notes, status, created_by, updated_by)
      values (${id}, ${s(body.title)}, ${s(body.documentType)}, ${s(body.entityType)}, ${s(body.entityId)},
        ${s(body.referenceNo)}, ${s(body.sourceUrl)}, ${s(body.fileName)}, ${version}, ${supersedesId},
        ${s(body.issueDate)}, ${s(body.expiryDate)}, ${s(body.notes)}, 'ACTIVE', ${principal.userId}, ${principal.userId})`;
    if (supersedesId) {
      await this.sql`update platform.document_registry set status = 'SUPERSEDED', updated_dt = now(), updated_by = ${principal.userId} where document_registry_id = ${supersedesId}`;
    }
    return this.get(id);
  }

  private async nextVersion(supersedesId: string): Promise<number> {
    const r = (await this.sql`select coalesce(version, 1) v from platform.document_registry where document_registry_id = ${supersedesId} limit 1`) as Array<{ v: number }>;
    return (Number(r[0]?.v) || 1) + 1;
  }
}
