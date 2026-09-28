/**
 * DispatchDocsService — the dispatch document chain (owner's dispatch diagram): Delivery Challan,
 * Invoice, E-Way Bill, Packing List, Proof of Delivery — one row per document, typed by
 * document_type, against a dispatch (+ its sales order / customer). Raw SQL over PG_CLIENT.
 *
 * Backing table: sales.dispatch_document, created by scripts/migrations/
 * 0014_adhoc_negotiation_advance_dispatch.sql (present on production since 2026-09-24). Lane F5
 * (RP-DEADTABLES, 2026-09-23) had switched this service to a NotImplemented refusal because the
 * table was not yet in any migration; PB-16 added the migration a day later and the refusal was
 * never lifted — the Factory "Dispatch docs" screen showed that refusal to users until lane
 * platform-roles (2026-09-28) restored the reads/writes. Every parameter is bound as text (see
 * body-fields.ts for why) and validated before it reaches Postgres.
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { BodyFields } from '../body-fields.js';

const WRITE_PERM = 'sales:dispatch_master:write';
export const DISPATCH_DOCUMENT_TYPES = [
  'DELIVERY_CHALLAN',
  'INVOICE',
  'EWAY_BILL',
  'PACKING_LIST',
  'PROOF_OF_DELIVERY',
] as const;

@Injectable()
export class DispatchDocsService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async list(limit = 200) {
    const lim = String(Math.min(Math.max(1, Number(limit) || 200), 500));
    const items = await this.sql`
      select dd.dispatch_document_id as "dispatchDocumentId", dd.dispatch_id as "dispatchId",
             so.so_number as "soNumber", c.customer_name as "customerName",
             dd.document_type as "documentType", dd.document_number as "documentNumber",
             dd.document_date::text as "documentDate", dd.amount as "amount", dd.reference as "reference",
             dd.received_by as "receivedBy", dd.status as "status"
        from sales.dispatch_document dd
        left join sales.dispatch_master dm on dm.dispatch_id = dd.dispatch_id
        left join sales.sales_order so on so.sales_order_id = coalesce(dd.sales_order_id, dm.sales_order_id)
        left join sales.customer_master c on c.customer_id = coalesce(dm.customer_id, so.customer_id)
       order by dd.created_dt desc, dd.dispatch_document_id desc
       limit ${lim}::int`;
    return { items, nextCursor: null };
  }

  async create(body: Record<string, unknown>, principal: AuthPrincipal) {
    if (!(principal.permissions || []).includes(WRITE_PERM)) {
      throw new ForbiddenException(`Missing permission ${WRITE_PERM}`);
    }
    const f = new BodyFields(body ?? {});
    const dispatchId = f.required('dispatchId', f.uuid('dispatchId'));
    const documentType = f.required('documentType', f.oneOf('documentType', DISPATCH_DOCUMENT_TYPES));
    const values = {
      documentNumber: f.text('documentNumber', 100),
      documentDate: f.date('documentDate'),
      amount: f.number('amount'),
      reference: f.text('reference', 200),
      receivedBy: f.text('receivedBy', 200),
      notes: f.text('notes'),
    };

    const dispatch = (await this.sql`
      select dispatch_id, sales_order_id from sales.dispatch_master where dispatch_id = ${dispatchId}::uuid`) as Array<{
      dispatch_id: string;
      sales_order_id: string | null;
    }>;
    if (!dispatch.length) throw new NotFoundException('That dispatch was not found.');

    const rows = (await this.sql`
      insert into sales.dispatch_document (dispatch_document_id, dispatch_id, sales_order_id, document_type,
        document_number, document_date, amount, reference, received_by, notes, status, created_by, updated_by)
      values (${uuidv7()}::uuid, ${dispatchId}::uuid, ${dispatch[0]!.sales_order_id}::uuid, ${documentType},
              ${values.documentNumber}, ${values.documentDate}::date, ${values.amount}::numeric, ${values.reference},
              ${values.receivedBy}, ${values.notes},
              ${documentType === 'PROOF_OF_DELIVERY' ? 'DELIVERED' : 'ISSUED'},
              ${principal.userId}, ${principal.userId})
      returning dispatch_document_id as "dispatchDocumentId", document_type as "documentType", status as "status"`) as Array<Record<string, unknown>>;
    return rows[0];
  }
}
