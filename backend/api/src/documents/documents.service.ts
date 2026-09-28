/**
 * DocumentsService — M01 Document Management (the base document_master is just a filename label).
 * Full registry: title, type, entity mapping (vendor/material/formula/customer), a source_url link
 * (no binary store), version history via supersedes_id, and expiry_date with a live days-to-expiry
 * so licences/COAs can be chased before they lapse. Creating a version with supersedesId flips the
 * prior document to SUPERSEDED in the same transaction. Raw SQL over the shared PG_CLIENT.
 *
 * Backing table: platform.document_registry, created by scripts/migrations/
 * 0015_adhoc_document_registry.sql (present on production since 2026-09-24). Lane F5
 * (RP-DEADTABLES, 2026-09-23) had switched this service to a NotImplemented refusal before that
 * migration existed and it was never lifted; lane platform-roles (2026-09-28) restored it. Every
 * parameter is bound as text (see body-fields.ts) and validated before it reaches Postgres.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { BodyFields } from '../body-fields.js';

export const DOCUMENT_ENTITY_TYPES = ['vendor', 'material', 'formula', 'customer', 'other'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class DocumentsService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  private select(filter: { id?: string | null; entityType?: string | null; entityId?: string | null }, lim: string) {
    const id = filter.id ?? null;
    const entityType = filter.entityType ?? null;
    const entityId = filter.entityId ?? null;
    return this.sql`
      select document_registry_id as "documentRegistryId", title, document_type as "documentType",
             entity_type as "entityType", entity_id as "entityId", reference_no as "referenceNo",
             source_url as "sourceUrl", file_name as "fileName", version, supersedes_id as "supersedesId",
             issue_date::text as "issueDate", expiry_date::text as "expiryDate",
             case when expiry_date is not null then (expiry_date - current_date) end as "daysToExpiry",
             notes, status, created_dt as "createdDt"
        from platform.document_registry
       where (${id}::uuid is null or document_registry_id = ${id}::uuid)
         and (${entityType}::text is null or entity_type = ${entityType}::text)
         and (${entityId}::uuid is null or entity_id = ${entityId}::uuid)
       order by expiry_date asc nulls last, created_dt desc, document_registry_id desc
       limit ${lim}::int`;
  }

  async list(opts: { limit?: number; entityType?: string; entityId?: string }) {
    const lim = String(Math.min(Math.max(1, Number(opts.limit) || 100), 200));
    const entityType = opts.entityType ? String(opts.entityType) : null;
    const entityId = opts.entityId ? String(opts.entityId) : null;
    if (entityId && !UUID.test(entityId)) throw new BadRequestException('entityId is not a valid id.');
    const items = await this.select({ entityType, entityId }, lim);
    return { items, nextCursor: null };
  }

  async get(id: string) {
    if (!UUID.test(String(id))) throw new NotFoundException('Document not found.');
    const rows = await this.select({ id }, '1');
    if (!rows.length) throw new NotFoundException('Document not found.');
    return rows[0];
  }

  async create(body: Record<string, unknown>, principal: AuthPrincipal) {
    const f = new BodyFields(body ?? {});
    const title = f.required('title', f.text('title', 300));
    const documentType = f.required('documentType', f.text('documentType', 100));
    const values = {
      entityType: f.oneOf('entityType', DOCUMENT_ENTITY_TYPES),
      entityId: f.uuid('entityId'),
      referenceNo: f.text('referenceNo', 200),
      sourceUrl: f.text('sourceUrl', 2000),
      fileName: f.text('fileName', 300),
      issueDate: f.date('issueDate'),
      expiryDate: f.date('expiryDate'),
      notes: f.text('notes'),
    };
    if (values.sourceUrl && !/^https?:\/\//i.test(values.sourceUrl)) {
      throw new BadRequestException('sourceUrl must be an http(s) link.');
    }
    const supersedesId = f.uuid('supersedesId');
    const id = uuidv7();

    await this.sql.begin(async (tx) => {
      let version = '1';
      if (supersedesId) {
        const prior = (await tx`
          select version from platform.document_registry
           where document_registry_id = ${supersedesId}::uuid for update`) as Array<{ version: number | string | null }>;
        if (!prior.length) throw new NotFoundException('The document being replaced was not found.');
        version = String((Number(prior[0]!.version) || 1) + 1);
      }
      await tx`
        insert into platform.document_registry
          (document_registry_id, title, document_type, entity_type, entity_id, reference_no,
           source_url, file_name, version, supersedes_id, issue_date, expiry_date, notes, status, created_by, updated_by)
        values (${id}::uuid, ${title}, ${documentType}, ${values.entityType}, ${values.entityId}::uuid,
          ${values.referenceNo}, ${values.sourceUrl}, ${values.fileName}, ${version}::int, ${supersedesId}::uuid,
          ${values.issueDate}::date, ${values.expiryDate}::date, ${values.notes}, 'ACTIVE', ${principal.userId}, ${principal.userId})`;
      if (supersedesId) {
        await tx`
          update platform.document_registry
             set status = 'SUPERSEDED', updated_dt = now(), updated_by = ${principal.userId}
           where document_registry_id = ${supersedesId}::uuid`;
      }
    });
    return this.get(id);
  }
}
