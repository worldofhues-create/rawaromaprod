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
    cols: { materialName: 'material_name', description: 'description', uomId: 'uom_id', materialGroupId: 'material_group_id', materialTypeId: 'material_type_id', materialCategoryId: 'material_category_id', status: 'status' },
  },
  vendors: {
    schema: 'procurement', table: 'vendor_details', pk: 'vendor_id', perm: 'procurement:vendor_details:write',
    cols: { vendorName: 'vendor_name', paymentTerms: 'payment_terms', baseCurrencyId: 'base_currency_id', addressId: 'address_id', status: 'status' },
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
