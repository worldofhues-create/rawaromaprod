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
  'dispatch-documents': {
    schema: 'sales', table: 'dispatch_document', pk: 'dispatch_document_id', perm: 'sales:dispatch_master:write',
    cols: { documentNumber: 'document_number', amount: 'amount', receivedBy: 'received_by', reference: 'reference', status: 'status' },
  },
  reservations: {
    schema: 'inventory', table: 'stock_reservation', pk: 'stock_reservation_id', perm: 'inventory:stock_reservation:write',
    cols: { status: 'status', reservedQty: 'reserved_qty' },
  },
  capas: {
    // CAPA lifecycle (audit #7): edit status (OPEN → IN_PROGRESS → CLOSED → VERIFIED) + fill the
    // root cause / action plan / closure evidence — was create-only.
    schema: 'quality', table: 'qc_capa', pk: 'qc_capa_id', perm: 'quality:qc_capa:write',
    cols: { status: 'status', capaType: 'capa_type', rootCause: 'root_cause', actionPlan: 'action_plan', closureEvidence: 'closure_evidence' },
  },
  'purchase-requests': {
    schema: 'procurement', table: 'purchase_request', pk: 'purchase_request_id', perm: 'procurement:purchase_request:write',
    cols: { status: 'status', priority: 'priority' },
  },
  'purchase-orders': {
    schema: 'procurement', table: 'purchase_order', pk: 'purchase_order_id', perm: 'procurement:purchase_order:write',
    cols: { status: 'status', orderDate: 'order_date' },
  },
  // RP-FAC: 'status' was removed from cols (audit H-C6 / registry RP-PROD-004 follow-up). The
  // generic editor was a live server-side bypass of OIL_TRANSITIONS (BatchService.transitionOilBatch)
  // — an API caller could PATCH status directly and jump straight to RELEASED from FAILED, skipping
  // the guard, the event_history row, and the outbox event. Oil-batch status now moves ONLY through
  // POST /v1/oil-batches/:id/transition. No other column on this table is editable here either.
  'oil-batches': {
    schema: 'production', table: 'oil_batch_master', pk: 'oil_batch_id', perm: 'production:oil_batch_master:write',
    cols: {},
  },
  'production-plans': {
    schema: 'production', table: 'production_plan', pk: 'production_plan_id', perm: 'production:production_plan:write',
    cols: { planDate: 'plan_date', status: 'status' },
  },
  'product-skus': {
    schema: 'packaging', table: 'product_sku', pk: 'product_sku_id', perm: 'packaging:product_sku:write',
    cols: { skuCode: 'sku_code', packSize: 'pack_size', status: 'status' },
  },
  products: {
    schema: 'packaging', table: 'product_master', pk: 'product_id', perm: 'packaging:product_master:write',
    cols: { productName: 'product_name', productCode: 'product_code', status: 'status' },
  },
  'packaging-boms': {
    schema: 'packaging', table: 'packaging_bom_master', pk: 'packaging_bom_id', perm: 'packaging:packaging_bom_master:write',
    cols: { requiredQty: 'required_qty', status: 'status' },
  },
  'quotation-items': {
    schema: 'procurement', table: 'quotation_items', pk: 'quotation_item_id', perm: 'procurement:quotation_items:write',
    cols: { quotedQty: 'quoted_qty', quotedRate: 'quoted_rate', status: 'status' },
  },
  'stock-requirements': {
    schema: 'procurement', table: 'stock_requirement', pk: 'stock_requirement_id', perm: 'procurement:stock_requirement:write',
    cols: { requiredQty: 'required_qty', priority: 'priority', requiredByDate: 'required_by_date', status: 'status' },
  },
  grns: { schema: 'inventory', table: 'grn_master', pk: 'grn_id', perm: 'inventory:grn_master:write', cols: { status: 'status' } },
  'grn-items': { schema: 'inventory', table: 'grn_items', pk: 'grn_item_id', perm: 'inventory:grn_master:write', cols: { receivedQty: 'received_qty', acceptedQty: 'accepted_qty', rejectedQty: 'rejected_qty', damagedQty: 'damaged_qty', varianceType: 'variance_type', varianceReason: 'variance_reason', status: 'status' } },
  'grn-containers': { schema: 'inventory', table: 'grn_container', pk: 'grn_container_id', perm: 'inventory:grn_container:write', cols: { containerCode: 'container_code', containerQty: 'container_qty', status: 'status' } },
  'batch-container-mappings': { schema: 'inventory', table: 'batch_container_mappings', pk: 'batch_container_mapping_id', perm: 'inventory:batch_container_mappings:write', cols: { status: 'status' } },
  rfqs: { schema: 'procurement', table: 'rfq_master', pk: 'rfq_id', perm: 'procurement:rfq_master:write', cols: { status: 'status' } },
  quotations: { schema: 'procurement', table: 'quotations', pk: 'quotation_id', perm: 'procurement:quotation_items:write', cols: { status: 'status' } },
  'po-advance-payments': { schema: 'procurement', table: 'po_advance_payment', pk: 'po_advance_payment_id', perm: 'procurement:purchase_order:write', cols: { amount: 'amount', reference: 'reference', status: 'status' } },
  'vendor-dispatches': { schema: 'procurement', table: 'vendor_dispatch', pk: 'vendor_dispatch_id', perm: 'procurement:purchase_order:read', cols: { dispatchDate: 'dispatch_date', transporter: 'transporter', docketNumber: 'docket_number', vehicleNumber: 'vehicle_number', status: 'status' } },
  'formula-versions': { schema: 'formula', table: 'formula_version', pk: 'formula_version_id', perm: 'formula:formula_version:write', cols: { status: 'status' } },
  'qc-parameters': { schema: 'quality', table: 'qc_parameter_master', pk: 'qc_parameter_id', perm: 'quality:qc_parameter_master:write', cols: { parameterCode: 'parameter_code', parameterName: 'parameter_name', status: 'status' } },
  'vendor-contacts': { schema: 'procurement', table: 'vendor_contact', pk: 'vendor_contact_id', perm: 'procurement:vendor_contact:write', cols: { contactName: 'contact_name', designation: 'designation', email: 'email', mobileNumber: 'mobile_number', contactType: 'contact_type', status: 'status' } },
  'vendor-negotiations': { schema: 'procurement', table: 'vendor_negotiation', pk: 'vendor_negotiation_id', perm: 'procurement:quotation_items:write', cols: { revisedRate: 'revised_rate', notes: 'notes', recommendation: 'recommendation', status: 'status' } },
  'vendor-rm-mappings': { schema: 'procurement', table: 'vendor_rm_mapping', pk: 'vendor_rm_mapping_id', perm: 'procurement:vendor_rm_mapping:write', cols: { isPreferred: 'is_preferred', leadTimeDays: 'lead_time_days', minOrderQty: 'min_order_qty', status: 'status' }, bool: ['is_preferred'] },
  contacts: { schema: 'platform', table: 'contact_master', pk: 'contact_id', perm: 'platform:contact_master:write', cols: { contactName: 'contact_name', email: 'email', mobileNumber: 'mobile_number', phone: 'phone', whatsapp: 'whatsapp', facebook: 'facebook', instagram: 'instagram', xHandle: 'x_handle', linkedin: 'linkedin', preferredLanguage: 'preferred_language', preferredContactMethod: 'preferred_contact_method', status: 'status' } },
  countries: { schema: 'platform', table: 'country_master', pk: 'country_id', perm: 'platform:country_master:write', cols: { countryName: 'country_name', currencyId: 'currency_id', timezone: 'timezone', status: 'status' } },
  locations: { schema: 'location', table: 'location_master', pk: 'location_id', perm: 'location:location_master:write', cols: { locationCode: 'location_code', locationName: 'location_name', locationTypeId: 'location_type_id', parentLocationId: 'parent_location_id', businessUnitId: 'business_unit_id', status: 'status' } },
  'location-types': { schema: 'location', table: 'location_type_master', pk: 'location_type_id', perm: 'location:location_type_master:write', cols: { typeCode: 'type_code', typeName: 'type_name', status: 'status' } },
  uoms: { schema: 'platform', table: 'uom_master', pk: 'uom_id', perm: 'platform:uom_master:write', cols: { uomCode: 'uom_code', uomName: 'uom_name', status: 'status' } },
  'business-units': { schema: 'iam', table: 'business_unit_master', pk: 'business_unit_id', perm: 'iam:business_unit_master:write', cols: { businessUnitName: 'business_unit_name', status: 'status' } },
  'material-types': { schema: 'masterdata', table: 'material_type_master', pk: 'material_type_id', perm: 'masterdata:material_type_master:write', cols: { typeName: 'type_name', status: 'status' } },
  'material-categories': { schema: 'masterdata', table: 'material_category_master', pk: 'material_category_id', perm: 'masterdata:material_category_master:write', cols: { categoryName: 'category_name', status: 'status' } },
  'material-subcategories': { schema: 'masterdata', table: 'material_subcategory_master', pk: 'material_subcategory_id', perm: 'masterdata:material_subcategory_master:write', cols: { subCategoryCode: 'sub_category_code', subCategoryName: 'sub_category_name', status: 'status' } },
  'material-groups': { schema: 'masterdata', table: 'material_group', pk: 'material_group_id', perm: 'masterdata:material_group:write', cols: { groupCode: 'group_code', groupName: 'group_name', status: 'status' } },
  'material-qc-specifications': { schema: 'masterdata', table: 'material_qc_specifications', pk: 'material_qc_specification_id', perm: 'masterdata:material_qc_specifications:write', cols: { minValue: 'min_value', maxValue: 'max_value', targetValue: 'target_value', status: 'status' } },
  'material-storage-rules': { schema: 'masterdata', table: 'material_storage_rules', pk: 'material_storage_rule_id', perm: 'masterdata:material_storage_rules:write', cols: { minTemperature: 'min_temperature', maxTemperature: 'max_temperature', storageCondition: 'storage_condition', status: 'status' } },
  'rm-aliases': { schema: 'masterdata', table: 'rm_alias', pk: 'rm_alias_id', perm: 'masterdata:rm_alias:write', cols: { aliasName: 'alias_name', aliasType: 'alias_type', status: 'status' } },
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
