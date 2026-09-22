/**
 * DispatchDocsService — the dispatch document chain (owner's dispatch diagram): Delivery Challan,
 * Invoice, E-Way Bill, Packing List, Proof of Delivery — one row per document, typed by
 * document_type, against a dispatch (+ its sales order / customer).
 *
 * NOT AVAILABLE (lane F5, RP-DEADTABLES): this used to query/insert `sales.dispatch_document` — a
 * table that does NOT exist in @ra/data-sales (the only source `pnpm db:push` draws the `sales`
 * schema from, per scripts/db-schema-groups.ts) and is not in the Phase-1A Data Dictionary. Any
 * real/dev database would 500 with "relation sales.dispatch_document does not exist" the instant
 * either method ran. Per CLAUDE.md C3 (no destructive migration; additive schema only if the
 * dictionary process permits it — report if locked), a new table is NOT added here. Both now
 * throw an honest NotImplementedException instead of crashing or fabricating rows; web/app.js's
 * generic error handling surfaces the message verbatim.
 * Unblocking it needs: `dispatch_document` added to the Phase-1A dictionary + @ra/data-sales
 * schema (columns as queried below), then db:push.
 */
import { ForbiddenException, Injectable, NotImplementedException } from '@nestjs/common';
import type { AuthPrincipal } from '@core/backend-kernel';

const WRITE_PERM = 'sales:dispatch_master:write';
const UNAVAILABLE =
  'Dispatch documents are not available: their backing table (sales.dispatch_document) was never added to the Phase-1A Data Dictionary or @ra/data-sales schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.';

@Injectable()
export class DispatchDocsService {
  async list(_limit = 200): Promise<never> {
    throw new NotImplementedException(UNAVAILABLE);
  }

  async create(_body: Record<string, unknown>, principal: AuthPrincipal): Promise<never> {
    if (!(principal.permissions || []).includes(WRITE_PERM)) {
      throw new ForbiddenException(`Missing permission ${WRITE_PERM}`);
    }
    throw new NotImplementedException(UNAVAILABLE);
  }
}
