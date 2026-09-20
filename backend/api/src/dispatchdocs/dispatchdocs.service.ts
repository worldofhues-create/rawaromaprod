/**
 * DispatchDocsService — the dispatch document chain (owner's dispatch diagram): Delivery Challan,
 * Invoice, E-Way Bill, Packing List, Proof of Delivery — one row per document, typed by
 * document_type, against a dispatch (+ its sales order / customer). Raw-SQL like the geo/procanalytics
 * modules. Reads gated to sales/dispatch roles; writes checked here.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

const WRITE_PERM = 'sales:dispatch_master:write';

@Injectable()
export class DispatchDocsService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async list(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select dd.dispatch_document_id as "dispatchDocumentId", dd.dispatch_id as "dispatchId",
             so.so_number as "soNumber", c.customer_name as "customerName",
             dd.document_type as "documentType", dd.document_number as "documentNumber",
             dd.document_date as "documentDate", dd.amount as "amount", dd.reference as "reference",
             dd.received_by as "receivedBy", dd.status as "status"
        from sales.dispatch_document dd
        left join sales.dispatch_master dm on dm.dispatch_id = dd.dispatch_id
        left join sales.sales_order so on so.sales_order_id = coalesce(dd.sales_order_id, dm.sales_order_id)
        left join sales.customer_master c on c.customer_id = dm.customer_id
       order by dd.created_dt desc
       limit ${lim}`;
    return { items, nextCursor: null };
  }

  async create(body: Record<string, unknown>, principal: AuthPrincipal) {
    if (!(principal.permissions || []).includes(WRITE_PERM)) {
      throw new ForbiddenException(`Missing permission ${WRITE_PERM}`);
    }
    const g = (k: string): string | null => {
      const v = body[k];
      return v == null || v === '' ? null : String(v);
    };
    if (!g('dispatchId')) throw new BadRequestException('dispatchId is required');
    if (!g('documentType')) throw new BadRequestException('documentType is required');
    const rows = (await this.sql`
      insert into sales.dispatch_document (dispatch_document_id, dispatch_id, sales_order_id, document_type,
        document_number, document_date, amount, reference, received_by, notes, status, created_by, updated_by)
      values (${randomUUID()}, ${g('dispatchId')}, ${g('salesOrderId')}, ${g('documentType')},
              ${g('documentNumber')}, ${g('documentDate')}, ${g('amount')}, ${g('reference')},
              ${g('receivedBy')}, ${g('notes')},
              ${g('documentType') === 'PROOF_OF_DELIVERY' ? 'DELIVERED' : 'ISSUED'},
              ${principal.userId}, ${principal.userId})
      returning dispatch_document_id as "dispatchDocumentId", document_type as "documentType", status as "status"`) as Array<Record<string, unknown>>;
    return rows[0];
  }
}
