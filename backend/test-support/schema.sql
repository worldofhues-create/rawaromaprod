-- RP-FAC test-support schema — the minimal slice of the Phase-1A schema the factory-sm state-
-- machine tests need (production → packaging QC → FG batch/reservation → sales dispatch). Column
-- names/types are hand-matched to packages/data-{production,packaging,sales}/src/schema/*.ts so
-- the real Drizzle table objects (and the real cluster services, unmodified) work against this
-- database. Not a substitute for `pnpm db:push` (which needs postgis + the full 12-schema set) —
-- this is a throwaway, single-purpose test database, created and torn down by the test harness.
create extension if not exists pgcrypto;
create schema if not exists production;
create schema if not exists packaging;
create schema if not exists sales;
create schema if not exists inventory;
create schema if not exists quality;
create schema if not exists procurement;
create schema if not exists masterdata;
create schema if not exists bridge;

-- RP-PROC (lane F3): minimal masterdata.material — ProcAnalyticsService.rateHistory left-joins it
-- to attach material names to rate-history rows (RP-PROC-007).
create table if not exists masterdata.material (
  material_id uuid primary key default gen_random_uuid(),
  material_code varchar(50),
  material_name varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- inventory (RP-FAC2) ------------------------------------------------------
create table if not exists inventory.inventory_batch (
  inventory_batch_id uuid primary key default gen_random_uuid(),
  rm_batch_id uuid,
  material_id uuid,
  storage_location_id uuid,
  inventory_status_id uuid,
  quantity_on_hand numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- RP-PROC (lane F3): GRN + RM batch, needed for ProcAnalyticsService.qcRejectedGrns/vendorPerformance
-- (RP-PROC-007) to test against real GRN -> rm_batch -> qc_inspections joins.
create table if not exists inventory.grn_master (
  grn_id uuid primary key default gen_random_uuid(),
  grn_number varchar(50),
  gate_entry_id uuid,
  purchase_order_id uuid,
  vendor_id uuid,
  location_id uuid,
  grn_date date,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists inventory.grn_items (
  grn_item_id uuid primary key default gen_random_uuid(),
  grn_id uuid references inventory.grn_master(grn_id),
  purchase_order_item_id uuid,
  material_id uuid,
  received_qty numeric(18,4),
  uom_id uuid,
  accepted_qty numeric(18,4),
  rejected_qty numeric(18,4),
  ordered_qty numeric(18,3),
  damaged_qty numeric(18,3),
  variance_qty numeric(18,3),
  variance_type text,
  variance_reason text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists inventory.rm_batch_master (
  rm_batch_id uuid primary key default gen_random_uuid(),
  grn_item_id uuid,
  material_id uuid,
  batch_number varchar(50),
  manufacturing_date date,
  expiry_date date,
  received_qty numeric(18,4),
  uom_id uuid,
  storage_location_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists inventory.stock_reservation (
  stock_reservation_id uuid primary key default gen_random_uuid(),
  inventory_batch_id uuid references inventory.inventory_batch(inventory_batch_id),
  reserved_qty numeric(18,4),
  uom_id uuid,
  reserved_for_document_id uuid,
  reserved_dt timestamptz,
  released_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists inventory.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

-- inventory (RP-PROD-004 — the real consumption ledger + its single-applier claim table, used
-- by ConsumptionService (backend/api/src/consumption) and MixingService.abortSession) ---------
create table if not exists inventory.inventory_event_history (
  inventory_event_history_id uuid primary key default gen_random_uuid(),
  inventory_batch_id uuid,
  event_type varchar(50),
  event_dt timestamptz,
  inventory_transaction_id uuid,
  reference_document_id uuid,
  reference_document_type varchar(50),
  event_qty numeric(18,4),
  performed_by uuid,
  remarks text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists inventory.material_issue_applied (
  material_issue_id uuid primary key,
  item_count integer,
  applied_dt timestamptz not null default now()
);

-- quality (RP-FAC2) ---------------------------------------------------------
create table if not exists quality.qc_inspections (
  qc_inspection_id uuid primary key default gen_random_uuid(),
  rm_batch_id uuid,
  inspection_role_id uuid,
  inspector_user_id uuid,
  inspection_dt timestamptz,
  overall_result varchar(255),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- RP-EMIT (lane F6): qc_disposition + quality.outbox, needed for InspectionsService.dispose
-- (quality/inspections/inspections.service.ts) — the qualityEvents.qcPassed/qcFailed emission
-- and the QcStatusChanged bridge hook wired beside it.
create table if not exists quality.qc_disposition (
  qc_disposition_id uuid primary key default gen_random_uuid(),
  qc_inspection_id uuid references quality.qc_inspections(qc_inspection_id),
  disposition_code varchar(50),
  disposition_reason text,
  conditions text,
  disposed_by uuid,
  disposed_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists quality.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

create table if not exists quality.qc_capa (
  qc_capa_id uuid primary key default gen_random_uuid(),
  qc_inspection_id uuid,
  capa_code varchar(50) unique,
  capa_type varchar(30),
  description text,
  root_cause text,
  action_plan text,
  assigned_to uuid,
  due_dt timestamptz,
  closed_dt timestamptz,
  closure_evidence text,
  verified_by uuid,
  verified_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- production additions (RP-FAC2 mixing + picking) --------------------------
create table if not exists production.production_order (
  production_order_id uuid primary key default gen_random_uuid(),
  production_plan_item_id uuid,
  formula_version_id uuid,
  location_id uuid,
  order_qty numeric(18,4),
  uom_id uuid,
  actual_start_dt timestamptz,
  actual_end_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.production_order_ingredients (
  production_order_ingredient_id uuid primary key default gen_random_uuid(),
  production_order_id uuid references production.production_order(production_order_id),
  material_id uuid,
  required_qty numeric(18,4),
  issued_qty boolean,
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.material_pick_list (
  material_pick_list_id uuid primary key default gen_random_uuid(),
  production_order_id uuid,
  pick_list_date date,
  generated_by uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.material_pick_list_items (
  material_pick_list_item_id uuid primary key default gen_random_uuid(),
  material_pick_list_id uuid references production.material_pick_list(material_pick_list_id),
  material_id uuid,
  inventory_batch_id uuid,
  picked_qty numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.material_issue (
  material_issue_id uuid primary key default gen_random_uuid(),
  production_order_id uuid,
  material_pick_list_id uuid,
  issued_dt timestamptz,
  issued_by uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.material_issue_item (
  material_issue_item_id uuid primary key default gen_random_uuid(),
  material_issue_id uuid references production.material_issue(material_issue_id),
  material_id uuid,
  inventory_batch_id uuid,
  issued_qty boolean,
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.secure_mixing_session (
  secure_mixing_session_id uuid primary key,
  production_order_id uuid,
  operator_id uuid,
  session_start_dt timestamptz,
  session_end_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.mixing_step_log (
  mixing_step_log_id uuid primary key,
  secure_mixing_session_id uuid references production.secure_mixing_session(secure_mixing_session_id),
  formula_stage_id uuid,
  step_sequence integer,
  step_description text,
  performed_dt timestamptz,
  performed_by uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- procurement (RP-FAC2) -----------------------------------------------------
create table if not exists procurement.purchase_request (
  purchase_request_id uuid primary key default gen_random_uuid(),
  pr_number varchar(50),
  stock_requirement_id uuid,
  request_location_id uuid,
  delivery_location_id uuid,
  priority varchar(30),
  expected_delivery_date date,
  approved_by uuid,
  approved_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.purchase_request_approval (
  purchase_request_approval_id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid references procurement.purchase_request(purchase_request_id),
  approver_user_id uuid,
  approval_level integer,
  approval_status varchar(30),
  approved_dt timestamptz,
  remarks text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- RP-PROC (lane F3): vendor_details + RFQ/quotation tables, needed to test the RFQ -> PO
-- "select winning quotation" award step (PoService.createPurchaseOrder / RfqService.selectQuotation).
create table if not exists procurement.vendor_details (
  vendor_id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  vendor_code varchar(50),
  vendor_name varchar(200),
  address_id uuid,
  base_currency_id uuid,
  payment_terms varchar(255),
  gstin text,
  pan_number text,
  bank_name text,
  bank_account_number text,
  bank_ifsc text,
  contact_email text,
  contact_phone text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
-- Defensive: edit-service-bypass.test.ts also opportunistically creates a MINIMAL
-- procurement.vendor_details (vendor_id/vendor_name/status only) with its own unguarded
-- `create table if not exists`, outside this file's advisory-locked schema application — whoever
-- runs first "wins" the table shape since IF NOT EXISTS won't widen an existing table. These
-- ADD COLUMN IF NOT EXISTS calls make this file's fuller shape authoritative either way.
alter table procurement.vendor_details add column if not exists organization_id uuid;
alter table procurement.vendor_details add column if not exists vendor_code varchar(50);
alter table procurement.vendor_details add column if not exists address_id uuid;
alter table procurement.vendor_details add column if not exists base_currency_id uuid;
alter table procurement.vendor_details add column if not exists payment_terms varchar(255);
alter table procurement.vendor_details add column if not exists gstin text;
alter table procurement.vendor_details add column if not exists pan_number text;
alter table procurement.vendor_details add column if not exists bank_name text;
alter table procurement.vendor_details add column if not exists bank_account_number text;
alter table procurement.vendor_details add column if not exists bank_ifsc text;
alter table procurement.vendor_details add column if not exists contact_email text;
alter table procurement.vendor_details add column if not exists contact_phone text;

create table if not exists procurement.rfq_master (
  rfq_id uuid primary key default gen_random_uuid(),
  rfq_number varchar(50),
  purchase_request_id uuid,
  rfq_date date,
  submission_deadline varchar(255),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.rfq_items (
  rfq_item_id uuid primary key default gen_random_uuid(),
  rfq_id uuid references procurement.rfq_master(rfq_id),
  material_id uuid,
  required_qty numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.rfq_vendor_mappings (
  rfq_vendor_mapping_id uuid primary key default gen_random_uuid(),
  rfq_id uuid references procurement.rfq_master(rfq_id),
  vendor_id uuid references procurement.vendor_details(vendor_id),
  is_selected_vendor boolean,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.quotations (
  quotation_id uuid primary key default gen_random_uuid(),
  rfq_id uuid references procurement.rfq_master(rfq_id),
  vendor_id uuid references procurement.vendor_details(vendor_id),
  quotation_number varchar(50),
  quotation_date date,
  valid_until_date date,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- Security review R1 #1: belt-and-suspenders for the double-award TOCTOU fix (the row lock in
-- RfqService.selectQuotation is the primary guard) — at most one SELECTED quotation per RFQ.
create unique index if not exists quotations_rfq_selected_uq
  on procurement.quotations (rfq_id) where status = 'SELECTED';

create table if not exists procurement.quotation_items (
  quotation_item_id uuid primary key default gen_random_uuid(),
  quotation_id uuid references procurement.quotations(quotation_id),
  material_id uuid,
  quoted_qty numeric(18,4),
  uom_id uuid,
  quoted_rate numeric(18,4),
  currency_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.purchase_order (
  purchase_order_id uuid primary key default gen_random_uuid(),
  po_number varchar(50),
  vendor_id uuid,
  quotation_id uuid,
  purchase_request_id uuid,
  order_date date,
  delivery_location_id uuid,
  currency_id uuid,
  total_amount numeric(18,2),
  replacement_of_po_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.purchase_order_items (
  purchase_order_item_id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid references procurement.purchase_order(purchase_order_id),
  material_id uuid,
  ordered_qty numeric(18,4),
  uom_id uuid,
  rate numeric(18,4),
  amount numeric(18,2),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.po_approval_order (
  po_approval_order_id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid references procurement.purchase_order(purchase_order_id),
  approver_user_id uuid,
  approval_level integer,
  approval_status varchar(30),
  approved_dt timestamptz,
  remarks text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.vendor_po_ack (
  vendor_po_ack_id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid,
  vendor_id uuid,
  acknowledged_dt timestamptz,
  accepted_delivery_date date,
  remarks text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

-- production --------------------------------------------------------------
create table if not exists production.oil_batch_master (
  oil_batch_id uuid primary key,
  production_order_id uuid,
  secure_mixing_session_id uuid,
  batch_number varchar(50),
  produced_qty numeric(18,4),
  uom_id uuid,
  produced_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.oil_batch_consumption (
  oil_batch_consumption_id uuid primary key,
  oil_batch_id uuid references production.oil_batch_master(oil_batch_id),
  consumed_for_document_id uuid,
  consumed_qty numeric(18,4),
  uom_id uuid,
  consumed_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.oil_batch_event_history (
  oil_batch_event_history_id uuid primary key,
  oil_batch_id uuid references production.oil_batch_master(oil_batch_id),
  event_type varchar(30),
  event_dt timestamptz,
  performed_by uuid,
  remarks text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- RP-EMIT (lane F6): production_qc + oil_batch_qc_history, needed for BatchService.
-- recordProductionQc (production/batch/batch.service.ts) — the QcStatusChanged emission hook.
create table if not exists production.production_qc (
  production_qc_id uuid primary key default gen_random_uuid(),
  oil_batch_id uuid,
  qc_parameter_id uuid,
  observed_value numeric(18,4),
  result varchar(255),
  inspected_by uuid,
  inspection_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.oil_batch_qc_history (
  oil_batch_qc_history_id uuid primary key default gen_random_uuid(),
  oil_batch_id uuid references production.oil_batch_master(oil_batch_id),
  production_qc_id uuid,
  recorded_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists production.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

-- packaging -----------------------------------------------------------------
create table if not exists packaging.finished_good_batch_master (
  finished_good_batch_id uuid primary key,
  package_order_id uuid,
  product_sku_id uuid,
  batch_number varchar(50),
  produced_qty numeric(18,4),
  uom_id uuid,
  manufacturing_date date,
  expiry_date date,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.finished_goods_batch_consumption (
  finished_goods_batch_consumption_id uuid primary key,
  finished_good_batch_id uuid references packaging.finished_good_batch_master(finished_good_batch_id),
  consumed_for_document_id uuid,
  consumed_qty numeric(18,4),
  uom_id uuid,
  consumed_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.finished_good_reservation (
  finished_good_reservation_id uuid primary key,
  finished_good_batch_id uuid references packaging.finished_good_batch_master(finished_good_batch_id),
  product_sku_id uuid,
  reserved_qty numeric(18,4),
  channel varchar(30),
  reserved_for_document_id uuid,
  reserved_dt timestamptz,
  released_dt timestamptz,
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.product_sku (
  product_sku_id uuid primary key default gen_random_uuid(),
  product_id uuid,
  sku_code varchar(50),
  pack_size varchar(255),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.packaging_bom_master (
  packaging_bom_id uuid primary key default gen_random_uuid(),
  product_sku_id uuid,
  packaging_material_id uuid,
  required_qty numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.package_order (
  package_order_id uuid primary key default gen_random_uuid(),
  product_sku_id uuid,
  oil_batch_id uuid,
  location_id uuid,
  order_qty numeric(18,4),
  uom_id uuid,
  planned_start_dt timestamptz,
  planned_end_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.package_order_item (
  package_order_item_id uuid primary key default gen_random_uuid(),
  package_order_id uuid references packaging.package_order(package_order_id),
  packaging_material_id uuid,
  required_qty numeric(18,4),
  issued_qty boolean,
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.filling_session (
  filling_session_id uuid primary key default gen_random_uuid(),
  package_order_id uuid,
  operator_id uuid,
  session_start_dt timestamptz,
  session_end_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.filling_session_details (
  filling_session_detail_id uuid primary key default gen_random_uuid(),
  filling_session_id uuid references packaging.filling_session(filling_session_id),
  filled_qty numeric(18,4),
  uom_id uuid,
  rejected_qty numeric(18,4),
  recorded_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists packaging.packaging_qc (
  packaging_qc_id uuid primary key,
  finished_good_batch_id uuid,
  package_order_id uuid,
  leakage_check text,
  label_check text,
  carton_check text,
  overall_result text,
  inspected_by uuid,
  inspection_dt timestamptz,
  status text,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);

create table if not exists packaging.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

-- sales -----------------------------------------------------------------
create table if not exists sales.dispatch_master (
  dispatch_id uuid primary key,
  sales_order_id uuid,
  customer_id uuid,
  dispatch_date date,
  vehicle_number varchar(20),
  transporter_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists sales.dispatch_items (
  dispatch_item_id uuid primary key,
  dispatch_id uuid references sales.dispatch_master(dispatch_id),
  sales_order_item_id uuid,
  finished_good_batch_id uuid,
  dispatched_qty numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists sales.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

-- bridge (RP-EMIT, lane F6) --------------------------------------------------
-- RawProd's local projection of ALEMBIC production requirements + the outbound outbox toward
-- ALEMBIC (backend/api/src/bridge/*, packages/data-bridge/src/schema/*). Only the two tables the
-- lane F6 emission hooks need against this harness — connector_config/inbound_event (the inbound
-- half) aren't exercised by these tests.
create table if not exists bridge.production_requirement (
  production_requirement_id uuid primary key default gen_random_uuid(),
  alembic_requirement_id uuid not null,
  org_id uuid not null,
  correlation_id uuid not null,
  order_ref varchar(100) not null,
  mapped_sku text not null,
  qty numeric(18,4) not null,
  uom varchar(20) not null,
  pack_size varchar(50),
  needed_by timestamptz not null,
  priority varchar(20) not null default 'normal',
  lifecycle_status varchar(30) not null default 'CREATED',
  status_reason text,
  production_order_id uuid,
  last_applied_version numeric not null default 0,
  last_emitted_version numeric not null default 0,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists bridge_production_requirement_alembic_id_uq
  on bridge.production_requirement (alembic_requirement_id);

create table if not exists bridge.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);
