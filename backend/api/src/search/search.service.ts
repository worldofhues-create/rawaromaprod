/**
 * SearchService — server-side search over the big list tables. The frontend search box used to
 * filter only the already-loaded first 100 rows (missing matches beyond the page); this searches
 * the WHOLE table server-side via a row-cast match (t::text ilike). A strict REGISTRY whitelists
 * which resources are searchable (no arbitrary table access); tables with secrets (users/formula)
 * are excluded. Snake_case columns are camelised so the result matches the list shape, and the
 * global MaterialMaskingInterceptor still masks materialId for non-reveal roles.
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
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
  // Portal-audit WS2: extend server-side search to every non-secret single-table browse list, so
  // the search box searches the WHOLE table (not just the loaded 100 rows) for the modules users
  // actually browse. Each schema.table was verified to physically exist and to carry NO secret
  // column (no password/hash/cipher/token/audit-chain) — a whole-row t::text ilike is safe.
  // Deliberately EXCLUDED (kept client-only): secrets (formula.*, iam.user_master/credentials/
  // login_history/otps/sessions, *.audit_events, relay_package), the MASKED worksheet
  // (production_order_ingredients) + secure_mixing_session, and computed read-models whose list
  // shape a single-table select can't reproduce (fg-stock, inventory-availability, packaging-qc,
  // reorder-suggestions, qc-rejected-grns, po-advance-payments, vendor-rate-history/-negotiations/
  // -performance/-ledger, notifications, dispatch-documents, approval-matrix, organizations, geo-*).
  '/v1/roles': { schema: 'iam', table: 'role_master' },
  '/v1/permissions': { schema: 'iam', table: 'permission_master' },
  '/v1/business-units': { schema: 'iam', table: 'business_unit_master' },
  '/v1/contacts': { schema: 'platform', table: 'contact_master' },
  '/v1/countries': { schema: 'platform', table: 'country_master' },
  '/v1/locations': { schema: 'location', table: 'location_master' },
  '/v1/location-types': { schema: 'location', table: 'location_type_master' },
  '/v1/shelves': { schema: 'location', table: 'shelf_master' },
  '/v1/rm-aliases': { schema: 'masterdata', table: 'rm_alias' },
  '/v1/material-types': { schema: 'masterdata', table: 'material_type_master' },
  '/v1/material-categories': { schema: 'masterdata', table: 'material_category_master' },
  '/v1/material-subcategories': { schema: 'masterdata', table: 'material_subcategory_master' },
  '/v1/material-groups': { schema: 'masterdata', table: 'material_group' },
  '/v1/material-qc-specifications': { schema: 'masterdata', table: 'material_qc_specifications' },
  '/v1/material-storage-rules': { schema: 'masterdata', table: 'material_storage_rules' },
  '/v1/qc-parameters': { schema: 'quality', table: 'qc_parameter_master' },
  '/v1/qc-result-details': { schema: 'quality', table: 'qc_result_details' },
  '/v1/qc-sample-retentions': { schema: 'quality', table: 'qc_sample_retention' },
  '/v1/production-qc': { schema: 'production', table: 'production_qc' },
  '/v1/production-plans': { schema: 'production', table: 'production_plan' },
  '/v1/production-plan-items': { schema: 'production', table: 'production_plan_items' },
  '/v1/material-pick-lists': { schema: 'production', table: 'material_pick_list' },
  '/v1/material-issues': { schema: 'production', table: 'material_issue' },
  '/v1/quotations': { schema: 'procurement', table: 'quotations' },
  '/v1/quotation-items': { schema: 'procurement', table: 'quotation_items' },
  '/v1/vendor-contacts': { schema: 'procurement', table: 'vendor_contact' },
  '/v1/vendor-rm-mappings': { schema: 'procurement', table: 'vendor_rm_mapping' },
  '/v1/vendor-credit-notes': { schema: 'procurement', table: 'vendor_credit_note' },
  '/v1/products': { schema: 'packaging', table: 'product_master' },
  '/v1/packaging-boms': { schema: 'packaging', table: 'packaging_bom_master' },
  '/v1/filling-sessions': { schema: 'packaging', table: 'filling_session' },
  '/v1/gate-entries': { schema: 'inventory', table: 'gate_entry_master' },
  '/v1/grn-items': { schema: 'inventory', table: 'grn_items' },
  '/v1/grn-containers': { schema: 'inventory', table: 'grn_container' },
  '/v1/stock-adjustments': { schema: 'inventory', table: 'stock_adjustment' },
  '/v1/stock-transfers': { schema: 'inventory', table: 'stock_transfer' },
  '/v1/stock-reservations': { schema: 'inventory', table: 'stock_reservation' },
  '/v1/stock-audits': { schema: 'inventory', table: 'stock_audit' },
  '/v1/inventory-transactions': { schema: 'inventory', table: 'inventory_transaction' },
  '/v1/batch-container-mappings': { schema: 'inventory', table: 'batch_container_mappings' },
};

// Per-resource read permission (audit H-S3): search must NOT bypass function-level auth. The perm
// is the same one the resource's list route requires (schema:table:read), so a caller can only
// search what they may already list. document-registry is a BFF whose perm differs from its table.
const PERM_OVERRIDE: Record<string, string> = { '/v1/document-registry': 'platform:document_master:read' };
function readPerm(endpoint: string, cfg: { schema: string; table: string }): string {
  return PERM_OVERRIDE[endpoint] ?? `${cfg.schema}:${cfg.table}:read`;
}

const camel = (k: string): string => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const camelKeys = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[camel(k)] = row[k];
  return out;
};

@Injectable()
export class SearchService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async search(endpoint: string, q: string, limit: number, principal: AuthPrincipal) {
    const cfg = REGISTRY[endpoint];
    if (!cfg) throw new NotFoundException(`"${endpoint}" is not searchable`);
    // Function-level auth: only search a resource you hold the read permission for.
    const perm = readPerm(endpoint, cfg);
    if (!(principal?.permissions ?? []).includes(perm)) {
      throw new ForbiddenException(`You do not have permission to search ${endpoint} (requires ${perm}).`);
    }
    const lim = Math.min(Math.max(1, limit || 100), 500);
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
