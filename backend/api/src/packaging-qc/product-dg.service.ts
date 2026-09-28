/**
 * ProductDgService (lane produce, owner requirement 2026-09-29) — a product's dangerous-goods /
 * hazard details, entered from its SDS by packaging/compliance and printed on its finished-good
 * labels "where set". Nothing is inferred: an empty field prints nothing.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';

const FIELDS: Array<[key: string, column: string, max: number, re?: RegExp]> = [
  ['unNumber', 'un_number', 10, /^(UN\s?)?\d{4}$/i],
  ['properShippingName', 'proper_shipping_name', 300],
  ['dgClass', 'dg_class', 10, /^[1-9](\.[1-6])?[A-Z]?$/],
  ['packingGroup', 'packing_group', 5, /^(I|II|III)$/],
  ['signalWord', 'signal_word', 20, /^(Danger|Warning)$/i],
  ['hazardStatements', 'hazard_statements', 2000],
];

@Injectable()
export class ProductDgService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async get(productId: string) {
    const r = (await this.sql`
      select product_id as "productId", un_number as "unNumber", proper_shipping_name as "properShippingName",
             dg_class as "dgClass", packing_group as "packingGroup", signal_word as "signalWord",
             hazard_statements as "hazardStatements", updated_dt as "updatedDt"
        from packaging.product_dg_info where product_id = ${productId}`)[0];
    return r ?? { productId, unNumber: null, properShippingName: null, dgClass: null, packingGroup: null, signalWord: null, hazardStatements: null, updatedDt: null };
  }

  async set(productId: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const product = (await this.sql`select 1 from packaging.product_master where product_id = ${productId}`)[0];
    if (!product) throw new NotFoundException(`product not found: ${productId}`);
    const v: Record<string, string | null> = {};
    const col = (c: string): string | null => v[c] ?? null;
    for (const [key, column, max, re] of FIELDS) {
      const raw = body?.[key];
      const s = raw === undefined || raw === null ? '' : String(raw).trim();
      if (s && (s.length > max || (re && !re.test(s)))) throw new BadRequestException(`${key} is not valid.`);
      v[column] = s || null;
    }
    await this.sql`
      insert into packaging.product_dg_info
        (product_id, un_number, proper_shipping_name, dg_class, packing_group, signal_word, hazard_statements, status, created_by, updated_by)
      values (${productId}, ${col('un_number')}, ${col('proper_shipping_name')}, ${col('dg_class')}, ${col('packing_group')}, ${col('signal_word')},
              ${col('hazard_statements')}, 'ACTIVE', ${principal.userId}, ${principal.userId})
      on conflict (product_id) do update set un_number = excluded.un_number, proper_shipping_name = excluded.proper_shipping_name,
        dg_class = excluded.dg_class, packing_group = excluded.packing_group, signal_word = excluded.signal_word,
        hazard_statements = excluded.hazard_statements, updated_dt = now(), updated_by = excluded.updated_by`;
    return this.get(productId);
  }
}
