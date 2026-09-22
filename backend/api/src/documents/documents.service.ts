/**
 * DocumentsService — M01 Document Management (the base document_master is just a filename label).
 * NOT AVAILABLE (lane F5, RP-DEADTABLES): this used to query/insert `platform.document_registry`
 * — a table that does NOT exist in @core/data-platform or @ra/data-reference (the only sources
 * `pnpm db:push` draws the `platform` schema from, per scripts/db-schema-groups.ts) and is not in
 * the Phase-1A Data Dictionary. Any real/dev database would 500 with "relation
 * platform.document_registry does not exist" the instant any of these ran — dead calls dressed up
 * as working ones. Per CLAUDE.md C3 (no destructive migration; additive schema only if the
 * dictionary process permits it — report if locked), a new table is NOT added here. These now
 * throw an honest NotImplementedException instead of crashing or fabricating rows; web/app.js's
 * generic error handling surfaces the message verbatim.
 * Unblocking it needs: `document_registry` added to the Phase-1A dictionary + @ra/data-reference
 * (or @core/data-platform) schema — title, document_type, entity_type, entity_id, reference_no,
 * source_url, file_name, version, supersedes_id, issue_date, expiry_date, notes, status — then
 * db:push.
 */
import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';

const UNAVAILABLE =
  'Document registry is not available: its backing table (platform.document_registry) was never added to the Phase-1A Data Dictionary or @core/data-platform / @ra/data-reference schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.';

@Injectable()
export class DocumentsService {
  // PG_CLIENT is kept injected (unused for now) so this service's constructor shape survives the
  // day document_registry is added to the dictionary and these methods are restored to real SQL.
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {
    void this.sql;
  }

  async list(_opts: { limit?: number; entityType?: string; entityId?: string }): Promise<never> {
    throw new NotImplementedException(UNAVAILABLE);
  }

  async get(_id: string): Promise<never> {
    throw new NotImplementedException(UNAVAILABLE);
  }

  async create(_body: Record<string, unknown>, _principal: AuthPrincipal): Promise<never> {
    throw new NotImplementedException(UNAVAILABLE);
  }
}
