/**
 * EditService — the cross-cutting "correct a mistake / deactivate" capability the clusters lack
 * (they are append + status-advance only). A strict REGISTRY whitelists exactly which master
 * resources are editable, which COLUMNS may change, and which write-permission is required — so
 * this is a controlled correction path, not an arbitrary UPDATE. Nothing outside the whitelist
 * (pk, created_*, password_hash, foreign flow state) can be touched. Deactivate is just a PATCH
 * of status→INACTIVE (or is_active→false for users). Perm is checked against the caller's token.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';

interface ResourceCfg {
  schema: string;
  table: string;
  pk: string;
  perm: string;
  /** editable camelCase field → db snake_case column. */
  cols: Record<string, string>;
  /** columns to coerce to boolean. */
  bool?: string[];
}

const REGISTRY: Record<string, ResourceCfg> = {
  materials: {
    schema: 'masterdata', table: 'material', pk: 'material_id', perm: 'masterdata:material:write',
    cols: { materialName: 'material_name', description: 'description', uomId: 'uom_id', materialGroupId: 'material_group_id', materialTypeId: 'material_type_id', materialCategoryId: 'material_category_id', scientificName: 'scientific_name', density: 'density', casNumber: 'cas_number', shelfLifeDays: 'shelf_life_days', reorderLevel: 'reorder_level', minStock: 'min_stock', maxStock: 'max_stock', qcRequired: 'qc_required', status: 'status' },
    bool: ['qc_required'],
  },
  vendors: {
    schema: 'procurement', table: 'vendor_details', pk: 'vendor_id', perm: 'procurement:vendor_details:write',
    cols: { vendorName: 'vendor_name', paymentTerms: 'payment_terms', baseCurrencyId: 'base_currency_id', addressId: 'address_id', gstin: 'gstin', panNumber: 'pan_number', bankName: 'bank_name', bankAccountNumber: 'bank_account_number', bankIfsc: 'bank_ifsc', contactEmail: 'contact_email', contactPhone: 'contact_phone', status: 'status' },
  },
  customers: {
    schema: 'sales', table: 'customer_master', pk: 'customer_id', perm: 'sales:customer_master:write',
    cols: { customerName: 'customer_name', baseCurrencyId: 'base_currency_id', addressId: 'address_id', status: 'status' },
  },
  transporters: {
    schema: 'sales', table: 'transporter_master', pk: 'transporter_id', perm: 'sales:transporter_master:write',
    cols: { transporterName: 'transporter_name', status: 'status' },
  },
  users: {
    schema: 'iam', table: 'user_master', pk: 'user_id', perm: 'iam:user_master:write',
    cols: { userName: 'user_name', email: 'email', mobileNumber: 'mobile_number', isActive: 'is_active', status: 'status' },
    bool: ['is_active'],
  },
  documents: {
    schema: 'platform', table: 'document_registry', pk: 'document_registry_id', perm: 'platform:document_master:write',
    cols: { title: 'title', documentType: 'document_type', entityType: 'entity_type', entityId: 'entity_id', referenceNo: 'reference_no', sourceUrl: 'source_url', fileName: 'file_name', issueDate: 'issue_date', expiryDate: 'expiry_date', notes: 'notes', status: 'status' },
  },
  dispatches: {
    schema: 'sales', table: 'dispatch_master', pk: 'dispatch_id', perm: 'sales:dispatch_master:write',
    cols: { status: 'status', vehicleNumber: 'vehicle_number', transporterId: 'transporter_id', dispatchDate: 'dispatch_date' },
  },
  reservations: {
    schema: 'inventory', table: 'stock_reservation', pk: 'stock_reservation_id', perm: 'inventory:stock_reservation:write',
    cols: { status: 'status', reservedQty: 'reserved_qty' },
  },
  'purchase-requests': {
    schema: 'procurement', table: 'purchase_request', pk: 'purchase_request_id', perm: 'procurement:purchase_request:write',
    cols: { status: 'status', priority: 'priority' },
  },
  'purchase-orders': {
    schema: 'procurement', table: 'purchase_order', pk: 'purchase_order_id', perm: 'procurement:purchase_order:write',
    cols: { status: 'status' },
  },
  'oil-batches': {
    schema: 'production', table: 'oil_batch_master', pk: 'oil_batch_id', perm: 'production:oil_batch_master:write',
    cols: { status: 'status' },
  },
  'product-skus': {
    schema: 'packaging', table: 'product_sku', pk: 'product_sku_id', perm: 'packaging:product_sku:write',
    cols: { skuCode: 'sku_code', packSize: 'pack_size', status: 'status' },
  },
  'stock-requirements': {
    schema: 'procurement', table: 'stock_requirement', pk: 'stock_requirement_id', perm: 'procurement:stock_requirement:write',
    cols: { requiredQty: 'required_qty', priority: 'priority', requiredByDate: 'required_by_date', status: 'status' },
  },
  grns: { schema: 'inventory', table: 'grn_master', pk: 'grn_id', perm: 'inventory:grn_master:write', cols: { status: 'status' } },
  rfqs: { schema: 'procurement', table: 'rfq_master', pk: 'rfq_id', perm: 'procurement:rfq_master:write', cols: { status: 'status' } },
  'formula-versions': { schema: 'formula', table: 'formula_version', pk: 'formula_version_id', perm: 'formula:formula_version:write', cols: { status: 'status' } },
  'qc-parameters': { schema: 'quality', table: 'qc_parameter_master', pk: 'qc_parameter_id', perm: 'quality:qc_parameter_master:write', cols: { parameterCode: 'parameter_code', parameterName: 'parameter_name', status: 'status' } },
  'vendor-contacts': { schema: 'procurement', table: 'vendor_contact', pk: 'vendor_contact_id', perm: 'procurement:vendor_contact:write', cols: { contactName: 'contact_name', designation: 'designation', email: 'email', mobileNumber: 'mobile_number', contactType: 'contact_type', status: 'status' } },
  'vendor-rm-mappings': { schema: 'procurement', table: 'vendor_rm_mapping', pk: 'vendor_rm_mapping_id', perm: 'procurement:vendor_rm_mapping:write', cols: { isPreferred: 'is_preferred', leadTimeDays: 'lead_time_days', minOrderQty: 'min_order_qty', status: 'status' }, bool: ['is_preferred'] },
  contacts: { schema: 'platform', table: 'contact_master', pk: 'contact_id', perm: 'platform:contact_master:write', cols: { contactName: 'contact_name', email: 'email', mobileNumber: 'mobile_number', status: 'status' } },
  countries: { schema: 'platform', table: 'country_master', pk: 'country_id', perm: 'platform:country_master:write', cols: { countryName: 'country_name', status: 'status' } },
  uoms: { schema: 'platform', table: 'uom_master', pk: 'uom_id', perm: 'platform:uom_master:write', cols: { uomCode: 'uom_code', uomName: 'uom_name', status: 'status' } },
  'business-units': { schema: 'iam', table: 'business_unit_master', pk: 'business_unit_id', perm: 'iam:business_unit_master:write', cols: { businessUnitName: 'business_unit_name', status: 'status' } },
  'material-types': { schema: 'masterdata', table: 'material_type_master', pk: 'material_type_id', perm: 'masterdata:material_type_master:write', cols: { typeName: 'type_name', status: 'status' } },
  'material-categories': { schema: 'masterdata', table: 'material_category_master', pk: 'material_category_id', perm: 'masterdata:material_category_master:write', cols: { categoryName: 'category_name', status: 'status' } },
  warehouses: { schema: 'location', table: 'warehouse_master', pk: 'warehouse_id', perm: 'location:warehouse_master:write', cols: { warehouseName: 'warehouse_name', status: 'status' } },
  floors: { schema: 'location', table: 'floor_master', pk: 'floor_id', perm: 'location:floor_master:write', cols: { floorName: 'floor_name', status: 'status' } },
  zones: { schema: 'location', table: 'zone_master', pk: 'zone_id', perm: 'location:zone_master:write', cols: { zoneName: 'zone_name', status: 'status' } },
  racks: { schema: 'location', table: 'rack_master', pk: 'rack_id', perm: 'location:rack_master:write', cols: { rackName: 'rack_name', status: 'status' } },
  shelves: { schema: 'location', table: 'shelf_master', pk: 'shelf_id', perm: 'location:shelf_master:write', cols: { shelfName: 'shelf_name', status: 'status' } },
  bins: { schema: 'location', table: 'bin_master', pk: 'bin_id', perm: 'location:bin_master:write', cols: { binName: 'bin_name', status: 'status' } },
};

@Injectable()
export class EditService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async update(resource: string, id: string, body: Record<string, unknown>, principal: AuthPrincipal) {
    const cfg = REGISTRY[resource];
    if (!cfg) throw new NotFoundException(`Unknown editable resource "${resource}"`);
    if (!(principal.permissions || []).includes(cfg.perm)) {
      throw new ForbiddenException(`Missing permission ${cfg.perm}`);
    }
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body || {})) {
      const col = cfg.cols[k];
      if (!col) continue; // silently ignore non-editable / unknown fields
      patch[col] = cfg.bool?.includes(col) ? v === true || v === 'true' || v === 1 : v;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('No editable fields supplied');
    patch.updated_by = principal.userId;

    const rows = (await this.sql`
      update ${this.sql.unsafe(`${cfg.schema}.${cfg.table}`)}
         set ${this.sql(patch)}, updated_dt = now()
       where ${this.sql.unsafe(cfg.pk)} = ${id}
       returning *`) as Array<Record<string, unknown>>;
    if (!rows.length) throw new NotFoundException(`${resource} ${id} not found`);
    return rows[0];
  }
}
