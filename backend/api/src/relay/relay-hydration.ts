/**
 * Relay hydration registry — maps each cross-gap event type to the domain row(s) that must travel
 * WITH it so the destination console can materialize the record (events alone are ids-only and
 * can't be rebuilt on a database that never saw the original write). On export the relay fetches
 * the aggregate's primary row (by aggregate_id = the pk) plus any child rows; on import it upserts
 * them by primary key (idempotent). PKs verified against the live schema.
 *
 * Only allow-listed event types appear here; `formula.*` is absent by design (never crosses).
 */
export interface RelayChildSpec {
  schema: string;
  table: string;
  fk: string; // child column that equals the aggregate id
  pk: string; // child primary key (for the upsert conflict target)
}
export interface RelayHydrationSpec {
  schema: string;
  table: string;
  pk: string; // primary key = the outbox aggregate_id
  children?: RelayChildSpec[];
}

export const RELAY_HYDRATION: Record<string, RelayHydrationSpec> = {
  // online → offline (orders + masters the factory needs to produce)
  'sales.order.created': {
    schema: 'sales', table: 'sales_order', pk: 'sales_order_id',
    children: [{ schema: 'sales', table: 'sales_order_items', fk: 'sales_order_id', pk: 'sales_order_item_id' }],
  },
  'sales.order.confirmed': { schema: 'sales', table: 'sales_order', pk: 'sales_order_id' },
  'masterdata.material.created': { schema: 'masterdata', table: 'material', pk: 'material_id' },
  'masterdata.alias.created': { schema: 'masterdata', table: 'rm_alias', pk: 'rm_alias_id' },
  'procurement.po.issued': {
    schema: 'procurement', table: 'purchase_order', pk: 'purchase_order_id',
    children: [{ schema: 'procurement', table: 'purchase_order_items', fk: 'purchase_order_id', pk: 'purchase_order_item_id' }],
  },

  // offline → online (production / QC / dispatch RESULTS — never a recipe)
  'packaging.fg_batch.created': { schema: 'packaging', table: 'finished_good_batch_master', pk: 'finished_good_batch_id' },
  'packaging.order.created': { schema: 'packaging', table: 'package_order', pk: 'package_order_id' },
  'packaging.filling.done': { schema: 'packaging', table: 'filling_session', pk: 'filling_session_id' },
  'quality.qc.passed': { schema: 'quality', table: 'qc_inspections', pk: 'qc_inspection_id' },
  'quality.qc.failed': { schema: 'quality', table: 'qc_inspections', pk: 'qc_inspection_id' },
  'quality.qc.hold': { schema: 'quality', table: 'qc_inspections', pk: 'qc_inspection_id' },
  'production.order.created': { schema: 'production', table: 'production_order', pk: 'production_order_id' },
  'production.materials.issued': { schema: 'production', table: 'material_issue', pk: 'material_issue_id' },
  'production.oil_batch.created': { schema: 'production', table: 'oil_batch_master', pk: 'oil_batch_id' },
  'production.qc.recorded': { schema: 'production', table: 'production_qc', pk: 'production_qc_id' },
  'inventory.grn.created': {
    schema: 'inventory', table: 'grn_master', pk: 'grn_id',
    children: [{ schema: 'inventory', table: 'grn_items', fk: 'grn_id', pk: 'grn_item_id' }],
  },
  'inventory.batch.created': { schema: 'inventory', table: 'rm_batch_master', pk: 'rm_batch_id' },
  'sales.dispatch.created': {
    schema: 'sales', table: 'dispatch_master', pk: 'dispatch_id',
    children: [{ schema: 'sales', table: 'dispatch_items', fk: 'dispatch_id', pk: 'dispatch_item_id' }],
  },
};
