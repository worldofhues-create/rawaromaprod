/**
 * MastersService — the sales reference masters: CUSTOMER_MASTER, TRANSPORTER_MASTER. Plain
 * CRUD (create + cursor list + get) for each. Pre-generated ids use uuidv7(); status defaults
 * to ACTIVE; created_by/updated_by = principal.userId; address / currency / contact are
 * platform soft refs (plain uuid, no FK at this layer).
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { SALES_DB, salesSchema, type SalesDb } from '../sales.tokens.js';
import { paginate, type Page } from '../_helpers.js';
import type { CreateCustomer, CreateTransporter, ListQuery } from '../sales.dtos.js';

const { customerMaster, transporterMaster } = salesSchema;

@Injectable()
export class MastersService {
  constructor(@Inject(SALES_DB) private readonly db: SalesDb) {}

  /* ── customer master ──────────────────────────────────────────────── */

  async createCustomer(body: CreateCustomer, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(customerMaster)
        .values({
          customerId: uuidv7(),
          customerCode: body.customerCode,
          customerName: body.customerName,
          addressId: body.addressId ?? null,
          baseCurrencyId: body.baseCurrencyId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: customer_master');
    return row;
  }

  async listCustomers(query: ListQuery): Promise<Page<typeof customerMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(customerMaster)
      .where(query.cursor ? lt(customerMaster.customerId, query.cursor) : undefined)
      .orderBy(desc(customerMaster.customerId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.customerId);
  }

  async getCustomer(id: string) {
    return (
      await this.db.select().from(customerMaster).where(eq(customerMaster.customerId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── transporter master ───────────────────────────────────────────── */

  async createTransporter(body: CreateTransporter, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(transporterMaster)
        .values({
          transporterId: uuidv7(),
          transporterCode: body.transporterCode,
          transporterName: body.transporterName,
          contactId: body.contactId ?? null,
          addressId: body.addressId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: transporter_master');
    return row;
  }

  async listTransporters(query: ListQuery): Promise<Page<typeof transporterMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(transporterMaster)
      .where(query.cursor ? lt(transporterMaster.transporterId, query.cursor) : undefined)
      .orderBy(desc(transporterMaster.transporterId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.transporterId);
  }

  async getTransporter(id: string) {
    return (
      await this.db
        .select()
        .from(transporterMaster)
        .where(eq(transporterMaster.transporterId, id))
        .limit(1)
    )[0] ?? null;
  }
}
