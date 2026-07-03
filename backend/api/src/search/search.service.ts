/**
 * SearchService — server-side search over the big list tables. The frontend search box used to
 * filter only the already-loaded first 100 rows (missing matches beyond the page); this searches
 * the WHOLE table server-side via a row-cast match (t::text ilike). A strict REGISTRY whitelists
 * which resources are searchable (no arbitrary table access); tables with secrets (users/formula)
 * are excluded. Snake_case columns are camelised so the result matches the list shape, and the
 * global MaterialMaskingInterceptor still masks materialId for non-reveal roles.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

// endpoint → { schema, table }. created_dt (metaColumns) exists on all, used for ordering.
const REGISTRY: Record<string, { schema: string; table: string }> = {
  '/v1/materials': { schema: 'masterdata', table: 'material' },
  '/v1/vendors': { schema: 'procurement', table: 'vendor_details' },
  '/v1/customers': { schema: 'sales', table: 'customer_master' },
  '/v1/transporters': { schema: 'sales', table: 'transporter_master' },
  '/v1/purchase-orders': { schema: 'procurement', table: 'purchase_order' },
  '/v1/purchase-requests': { schema: 'procurement', table: 'purchase_request' },
  '/v1/rfqs': { schema: 'procurement', table: 'rfq_master' },
  '/v1/stock-requirements': { schema: 'procurement', table: 'stock_requirement' },
  '/v1/grns': { schema: 'inventory', table: 'grn_master' },
  '/v1/rm-batches': { schema: 'inventory', table: 'rm_batch_master' },
  '/v1/qc-inspections': { schema: 'quality', table: 'qc_inspections' },
  '/v1/production-orders': { schema: 'production', table: 'production_order' },
  '/v1/oil-batches': { schema: 'production', table: 'oil_batch_master' },
  '/v1/package-orders': { schema: 'packaging', table: 'package_order' },
  '/v1/finished-good-batches': { schema: 'packaging', table: 'finished_good_batch_master' },
  '/v1/product-skus': { schema: 'packaging', table: 'product_sku' },
  '/v1/sales-orders': { schema: 'sales', table: 'sales_order' },
  '/v1/dispatches': { schema: 'sales', table: 'dispatch_master' },
  '/v1/document-registry': { schema: 'platform', table: 'document_registry' },
  '/v1/uoms': { schema: 'platform', table: 'uom_master' },
  '/v1/warehouses': { schema: 'location', table: 'warehouse_master' },
  '/v1/floors': { schema: 'location', table: 'floor_master' },
  '/v1/zones': { schema: 'location', table: 'zone_master' },
  '/v1/racks': { schema: 'location', table: 'rack_master' },
  '/v1/bins': { schema: 'location', table: 'bin_master' },
};

const camel = (k: string): string => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const camelKeys = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[camel(k)] = row[k];
  return out;
};

@Injectable()
export class SearchService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async search(endpoint: string, q: string, limit = 100) {
    const cfg = REGISTRY[endpoint];
    if (!cfg) throw new NotFoundException(`"${endpoint}" is not searchable`);
    const lim = Math.min(Math.max(1, limit), 500);
    const term = `%${String(q || '').trim()}%`;
    const rows = (await this.sql.unsafe(
      `select * from ${cfg.schema}.${cfg.table} as t where t::text ilike $1 order by t.created_dt desc nulls last limit ${lim}`,
      [term],
    )) as Array<Record<string, unknown>>;
    return { items: rows.map(camelKeys), nextCursor: null };
  }

  searchable(endpoint: string): boolean {
    return !!REGISTRY[endpoint];
  }
}
