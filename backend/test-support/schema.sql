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
-- G4 (lane F3): platform.tutorial_progress — see below.
create schema if not exists platform;
-- RP-POLICY (lane F8): iam — org + user + the new approval_matrix policy table (§87).
create schema if not exists iam;

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
-- D3 (demo-seed): MaterialService.createMaterial (backend/cluster-masterdata/src/material/
-- material.service.ts) writes the full packages/data-masterdata/src/schema/material.ts column
-- set. Purely additive/nullable, no FK enforcement here (matching this harness's existing
-- convention of plain soft-ref columns, not this Drizzle schema's in-schema FKs).
alter table masterdata.material add column if not exists material_group_id uuid;
alter table masterdata.material add column if not exists material_type_id uuid;
alter table masterdata.material add column if not exists material_category_id uuid;
alter table masterdata.material add column if not exists uom_id uuid;
alter table masterdata.material add column if not exists description text;
alter table masterdata.material add column if not exists scientific_name text;
alter table masterdata.material add column if not exists density numeric(12,4);
alter table masterdata.material add column if not exists cas_number text;
alter table masterdata.material add column if not exists shelf_life_days integer;
alter table masterdata.material add column if not exists reorder_level numeric(18,4);
alter table masterdata.material add column if not exists min_stock numeric(18,4);
alter table masterdata.material add column if not exists max_stock numeric(18,4);
alter table masterdata.material add column if not exists qc_required boolean;

-- D3 (demo-seed): masterdata.material_type_master — ClassificationService.createMaterialType
-- (backend/cluster-masterdata/src/classification/classification.service.ts); missing entirely
-- from this harness until now.
create table if not exists masterdata.material_type_master (
  material_type_id uuid primary key default gen_random_uuid(),
  type_code varchar(50),
  type_name varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists material_type_master_code_uq on masterdata.material_type_master (type_code);

-- D3 (demo-seed): masterdata.outbox — MaterialService.createMaterial/createRmAlias record
-- `masterdata.material.created`/`masterdata.alias.created` here (recordOutbox, @core/data-
-- kernel's outboxTable shape); missing entirely from this harness until now (mirrors
-- inventory.outbox / quality.outbox / production.outbox elsewhere in this file).
create table if not exists masterdata.outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  aggregate_id uuid,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  seq bigint generated always as identity
);

-- RP-S1 (lane S1, security review item 3): masterdata.rm_alias — DashboardService.
-- traceFinishedGood left-joins it to resolve the masked material identity.
create table if not exists masterdata.rm_alias (
  rm_alias_id uuid primary key default gen_random_uuid(),
  material_id uuid references masterdata.material(material_id),
  alias_name varchar(200),
  alias_type varchar(30),
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
-- D3 (demo-seed): inventory.gate_entry_master — GateService.createGateEntry; missing entirely
-- from this harness until now.
create table if not exists inventory.gate_entry_master (
  gate_entry_id uuid primary key default gen_random_uuid(),
  gate_entry_number varchar(50),
  vendor_id uuid,
  purchase_order_id uuid,
  location_id uuid,
  vehicle_number varchar(20),
  entry_dt timestamptz,
  exit_dt timestamptz,
  driver_name varchar(200),
  invoice_number text,
  challan_number text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

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

-- D3 (demo-seed): inventory.stock_transfer — StockService.createStockTransfer; missing
-- entirely from this harness until now.
create table if not exists inventory.stock_transfer (
  stock_transfer_id uuid primary key default gen_random_uuid(),
  inventory_batch_id uuid references inventory.inventory_batch(inventory_batch_id),
  from_location_id uuid,
  to_location_id uuid,
  transfer_qty numeric(18,4),
  uom_id uuid,
  transfer_dt timestamptz,
  requested_by uuid,
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

-- D3 (demo-seed): quality.qc_result_details — InspectionsService.addResults; missing entirely
-- from this harness until now.
create table if not exists quality.qc_result_details (
  qc_result_detail_id uuid primary key default gen_random_uuid(),
  qc_inspection_id uuid references quality.qc_inspections(qc_inspection_id),
  qc_parameter_id uuid,
  observed_value numeric(18,4),
  observed_text text,
  result varchar(255),
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
  material_pick_list_item_id uuid,
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
alter table production.material_issue_item add column if not exists material_pick_list_item_id uuid;
alter table production.production_order_ingredients add column if not exists issued_amount numeric(28,10);

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

-- L-AR (PB-06, RawProd Facts API): procurement.purchase_request_items — matches
-- packages/data-procurement/src/schema/requirement.ts's purchaseRequestItems exactly.
-- Needed by facts.service.ts's production_requirement_status pending-approval blocker
-- (joins a production order's unissued ingredient materials to an open PR line, then to
-- its approval); omitted from this file until now even though the real cluster schema
-- always had it.
create table if not exists procurement.purchase_request_items (
  purchase_request_item_id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid references procurement.purchase_request(purchase_request_id),
  material_id uuid,
  required_qty numeric(18,4),
  uom_id uuid,
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
  cancellation_reason text,
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

-- RP-POLICY (lane F8): procurement.audit_events — matches @core/data-kernel's auditTable()
-- shape (packages/data-procurement/src/schema/crosscutting.ts). RfqService.selectQuotation
-- writes one row here on every RFQ-award separation-of-duties override (§87).
create table if not exists procurement.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  ip text,
  occurred_at timestamptz not null default now(),
  chain_seq bigint,
  prev_hash text,
  row_hash text
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

-- RP-S1 (lane S1, security review item 3): packaging.product_master — DashboardService.
-- traceFinishedGood left-joins it (via product_sku.product_id) for the product name.
-- D3 (demo-seed): packaging.product_category_master + packaging.packaging_material_master —
-- PackagingCatalogService.createProductCategory/createPackagingMaterial; missing entirely from
-- this harness until now (product_master/packaging_bom_master below already carry the
-- soft-ref uuid columns pointing at these, just never had the tables themselves).
create table if not exists packaging.product_category_master (
  product_category_id uuid primary key default gen_random_uuid(),
  category_code varchar(50),
  category_name varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists product_category_master_code_uq on packaging.product_category_master (category_code);

create table if not exists packaging.packaging_material_master (
  packaging_material_id uuid primary key default gen_random_uuid(),
  packaging_material_code varchar(50),
  packaging_material_name varchar(200),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists packaging_material_master_code_uq on packaging.packaging_material_master (packaging_material_code);

create table if not exists packaging.product_master (
  product_id uuid primary key default gen_random_uuid(),
  formula_id uuid,
  brand_id uuid,
  product_category_id uuid,
  product_code varchar(50),
  product_name varchar(200),
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
-- RP-S1 (lane S1, security review item 3): sales.customer_master / sales.sales_order —
-- DashboardService.traceFinishedGood left-joins them for the customer/SO on the trace's
-- forward end.
create table if not exists sales.customer_master (
  customer_id uuid primary key default gen_random_uuid(),
  customer_code varchar(50),
  customer_name varchar(200),
  address_id uuid,
  base_currency_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists sales.sales_order (
  sales_order_id uuid primary key default gen_random_uuid(),
  so_number varchar(50),
  customer_id uuid,
  order_date date,
  delivery_location_id uuid,
  currency_id uuid,
  total_amount numeric(18,4),
  origin varchar(30),
  alembic_ref uuid,
  continuity_reason text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- G1/PB-08: sales_order_items — was missing from this hand-maintained slice (no prior test
-- exercised OrdersService.createSalesOrder's header+lines transaction directly). Column-matched
-- to packages/data-sales/src/schema/orders.ts's salesOrderItems.
create table if not exists sales.sales_order_items (
  sales_order_item_id uuid primary key default gen_random_uuid(),
  sales_order_id uuid references sales.sales_order(sales_order_id),
  product_sku_id uuid,
  ordered_qty numeric(18,4),
  uom_id uuid,
  rate numeric(18,4),
  amount numeric(18,4),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

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

-- L-AR (PB-06, RawProd Facts API): sales.transporter_master — matches
-- packages/data-sales/src/schema/customers.ts's transporterMaster exactly. Needed by
-- facts.service.ts's dispatch_status fact kind (dispatch_master.transporter_id -> here);
-- omitted from this file until now even though the real cluster schema always had it.
create table if not exists sales.transporter_master (
  transporter_id uuid primary key default gen_random_uuid(),
  transporter_code varchar(50),
  transporter_name varchar(200),
  contact_id uuid,
  address_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  unique (transporter_code)
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

-- iam (RP-POLICY, lane F8): org_master + user_master (minimal, matching packages/data-org/src/
-- schema/{org,users}.ts) + the new approval_matrix policy table (matching packages/data-org/src/
-- schema/policy.ts) — needed by PoService.approvePurchaseOrder / RfqService.selectQuotation to
-- resolve the caller's/creator's organisation and its configured PO-threshold / RFQ-award-
-- separation policy (§87). -----------------------------------------------------------------
create table if not exists iam.org_master (
  organization_id uuid primary key default gen_random_uuid(),
  organization_code varchar(50),
  organization_name varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
-- D3 (demo-seed): OrgService.createOrg (backend/cluster-org/src/org/org.service.ts) writes the
-- full packages/data-org/src/schema/org.ts column set unconditionally (undefined optional
-- fields still reach the generated INSERT's column list) — this harness's org_master predated
-- those columns. Purely additive/nullable, matching the real schema exactly (soft refs, no FK
-- here either); safe to add to an already-populated table.
alter table iam.org_master add column if not exists org_group_id uuid;
alter table iam.org_master add column if not exists org_type_id uuid;
alter table iam.org_master add column if not exists registration_country_id uuid;
alter table iam.org_master add column if not exists base_currency_id uuid;
alter table iam.org_master add column if not exists default_timezone_id uuid;
alter table iam.org_master add column if not exists default_language_id uuid;

create table if not exists iam.user_master (
  user_id uuid primary key default gen_random_uuid(),
  organization_id uuid references iam.org_master(organization_id),
  employee_code varchar(50),
  user_name varchar(200),
  email varchar(150),
  mobile_number varchar(20),
  password_hash varchar(255),
  is_active boolean,
  -- S3 security review item 1: the ALEMBIC staff id (assertion `sub`) this row is bound to,
  -- once a first successful alembic-assertion login has claimed it. See
  -- packages/data-org/src/schema/users.ts's own comment.
  alembic_subject varchar(255),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists user_master_alembic_subject_uq
  on iam.user_master (alembic_subject) where alembic_subject is not null;
-- Lane vaultsetup (2026-10-05): HUMAN or SERVICE (the non-login "Ruh (automation)" principal) —
-- scripts/migrations/2026-10-05-formula-setup.sql.
alter table iam.user_master add column if not exists account_kind varchar(20) not null default 'HUMAN';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_master_account_kind_chk') then
    alter table iam.user_master add constraint user_master_account_kind_chk check (account_kind in ('HUMAN', 'SERVICE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_master_service_no_login_chk') then
    alter table iam.user_master add constraint user_master_service_no_login_chk
      check (account_kind <> 'SERVICE' or (password_hash is null and alembic_subject is null));
  end if;
end $$;

-- S3 security review item 4: Postgres-backed single-use store for alembic-assertion `jti`s
-- (replaces AuthService's old in-process Map). See packages/data-org/src/schema/assertion-jti.ts.
create table if not exists iam.assertion_jti (
  jti varchar(255) primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists iam.approval_matrix (
  approval_matrix_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references iam.org_master(organization_id),
  policy_type varchar(50) not null,
  threshold_amount numeric(18,4),
  is_enabled boolean,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  unique (organization_id, policy_type)
);

-- RP-S1 (lane S1, security review): the RBAC tables SecurityService (backend/cluster-org/src/
-- security/security.service.ts) reads/writes — role_master/permission_master/
-- role_permission_mapping/user_role_mapping/location_authority_master. Column names/types
-- hand-matched to packages/data-org/src/schema/security.ts (@ra/data-org's orgSchema, the
-- schema backend/test-support/db.ts's orgDb() is typed against).
create table if not exists iam.role_master (
  role_id uuid primary key default gen_random_uuid(),
  role_code varchar(50),
  role_name varchar(200),
  description text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  unique (role_code)
);

create table if not exists iam.permission_master (
  permission_id uuid primary key default gen_random_uuid(),
  permission_code varchar(50),
  permission_name varchar(200),
  module_name varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  unique (permission_code)
);

create table if not exists iam.role_permission_mapping (
  role_permission_mapping_id uuid primary key default gen_random_uuid(),
  role_id uuid references iam.role_master(role_id),
  permission_id uuid references iam.permission_master(permission_id),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  unique (role_id, permission_id)
);
create index if not exists role_permission_mapping_role_idx on iam.role_permission_mapping (role_id);

create table if not exists iam.user_role_mapping (
  user_role_mapping_id uuid primary key default gen_random_uuid(),
  user_id uuid references iam.user_master(user_id),
  role_id uuid references iam.role_master(role_id),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  unique (user_id, role_id)
);
create index if not exists user_role_mapping_user_idx on iam.user_role_mapping (user_id);

-- S2 item A: two-person control on assigning formulator/vault_approver — see
-- packages/data-org/src/schema/security.ts's vaultRoleGrantRequest and
-- SecurityService.createUserRole / approveVaultRoleGrant / cancelVaultRoleGrantRequest.
create table if not exists iam.vault_role_grant_request (
  vault_role_grant_request_id uuid primary key default gen_random_uuid(),
  user_id uuid references iam.user_master(user_id),
  role_id uuid references iam.role_master(role_id),
  grant_status varchar(30) not null default 'PENDING',
  expires_dt timestamptz not null,
  decided_by uuid references iam.user_master(user_id),
  decided_dt timestamptz,
  decision_reason text,
  user_role_mapping_id uuid references iam.user_role_mapping(user_role_mapping_id),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create index if not exists vault_role_grant_request_user_idx on iam.vault_role_grant_request (user_id);
create index if not exists vault_role_grant_request_status_idx on iam.vault_role_grant_request (grant_status);

create table if not exists iam.location_authority_master (
  location_authority_id uuid primary key default gen_random_uuid(),
  location_id uuid,
  authority_user_id uuid references iam.user_master(user_id),
  authority_role_id uuid references iam.role_master(role_id),
  authority_type varchar(50),
  effective_from_dt timestamptz,
  effective_to_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- bridge (RP-EMIT, lane F6) --------------------------------------------------
-- RawProd's local projection of ALEMBIC production requirements + the outbound outbox toward
-- ALEMBIC (backend/api/src/bridge/*, packages/data-bridge/src/schema/*). Only the two tables the
-- lane F6 emission hooks need against this harness — connector_config/inbound_event (the inbound
-- half) aren't exercised by these tests.
-- D3 (demo-seed): bridge.inbound_event — ImporterService.handleAlembicEvent's dedupe table
-- (packages/data-bridge/src/schema/inbound-event.ts); genuinely exercised now (the real
-- inbound importer path), unlike when the comment above was written.
create table if not exists bridge.inbound_event (
  event_id uuid primary key,
  version integer not null,
  type text not null,
  aggregate_id uuid not null,
  correlation_id uuid not null,
  causation_id uuid,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  payload jsonb not null,
  processed_at timestamptz,
  parked_reason text
);

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
-- D3 (demo-seed): the real Drizzle schema (packages/data-bridge/src/schema/
-- production-requirement.ts) tacks `...metaColumns()` onto this table too — a generic
-- `status` column DISTINCT from the business-specific `lifecycle_status` above — which this
-- harness's hand-written DDL omitted. ImporterService's plain `.select()` lists every
-- schema-defined column by name, so it needs to exist even though this script never reads it.
alter table bridge.production_requirement add column if not exists status varchar(30);

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

-- OPS_GREEN §17 (P1): bridge.outbox_delivery — backoff + dead-letter state beside bridge.outbox
-- (packages/data-bridge/src/schema/outbox-delivery.ts, scripts/migrations/0023_adhoc_bridge_outbox_delivery.sql),
-- and bridge.audit_events (@core/data-kernel auditTable()) the relay's park/replay/discard write.
create table if not exists bridge.outbox_delivery (
  outbox_id uuid primary key,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  last_http_status integer,
  parked_at timestamptz,
  parked_reason varchar(20),
  discarded_at timestamptz,
  discarded_by varchar(255),
  discard_reason text,
  updated_at timestamptz not null default now()
);
create table if not exists bridge.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  ip text,
  occurred_at timestamptz not null default now(),
  chain_seq bigint,
  prev_hash text,
  row_hash text
);

-- bridge.connector_config — self-service outbound webhook URL + sealed HMAC secret (security
-- review R1 #4/#5 tests exercise ConfigAdminService/BridgeController against this table).
create table if not exists bridge.connector_config (
  id varchar(50) primary key default 'default',
  enabled boolean not null default false,
  webhook_url text,
  hmac_secret_sealed text,
  configured_at timestamptz,
  configured_by varchar(255)
);

-- S3 security review item 5: replay store for the Facts API's signed-request nonce. See
-- packages/data-bridge/src/schema/facts-nonce.ts.
create table if not exists bridge.facts_nonce (
  nonce varchar(255) primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- RP-F2 (lane F2, G3 factory automation) ------------------------------------
-- automation.* — idempotency ledger + decision log + dead-letter queue every automation rule
-- (backend/api/src/automation/*) runs through. See scripts/migrations/0020_adhoc_g3_automation.sql.
create schema if not exists automation;
create schema if not exists platform;

-- D3 (demo-seed): platform.uom_master — UomService.createUom (backend/cluster-reference/src/
-- uom/uom.service.ts) writes here (packages/data-reference/src/schema/uom.ts); missing from
-- this harness entirely until now. Minimal dictionary shape, matching the real schema.
create table if not exists platform.uom_master (
  uom_id uuid primary key default gen_random_uuid(),
  uom_code varchar(50),
  uom_name varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists uom_master_code_uq on platform.uom_master (uom_code);

-- Books phase 2 payables facts (backend-kernel events/payables-facts.ts) read a PO's currency
-- code from platform.currency_master (packages/data-reference/src/schema/geo.ts). Same shape.
create table if not exists platform.currency_master (
  currency_id uuid primary key default gen_random_uuid(),
  currency_code varchar(50),
  currency_name varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists currency_master_code_uq on platform.currency_master (currency_code);

create table if not exists automation.applied (
  rule_code varchar(64) not null,
  dedupe_key varchar(255) not null,
  status varchar(16) not null default 'PENDING',
  attempts integer not null default 0,
  last_error text,
  applied_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  primary key (rule_code, dedupe_key)
);

create table if not exists automation.decision_log (
  decision_log_id uuid primary key default gen_random_uuid(),
  rule_code varchar(64) not null,
  dedupe_key varchar(255) not null,
  event_type text,
  aggregate_id uuid,
  decision varchar(16) not null,
  reason text,
  inputs jsonb,
  outputs jsonb,
  created_dt timestamptz not null default now()
);

create table if not exists automation.dead_letter (
  dead_letter_id uuid primary key default gen_random_uuid(),
  rule_code varchar(64) not null,
  dedupe_key varchar(255) not null,
  event_type text,
  payload jsonb,
  error text,
  attempts integer not null default 0,
  first_failed_dt timestamptz not null default now(),
  last_failed_dt timestamptz not null default now(),
  unique (rule_code, dedupe_key)
);

-- procurement.stock_requirement / stock_req_items — Phase-1A dictionary tables (requirement.ts)
-- never previously added to this test harness.
create table if not exists procurement.stock_requirement (
  stock_requirement_id uuid primary key default gen_random_uuid(),
  location_id uuid,
  material_id uuid,
  required_qty numeric(18,4),
  uom_id uuid,
  required_by_date date,
  requirement_source varchar(255),
  priority varchar(255),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- G4 (lane F3): platform.tutorial_progress — TutorialService (backend/api/src/tutorial/
-- tutorial.service.ts), matching scripts/migrations/2026-09-24-tutorial-system.sql column-for-
-- column (this harness uses gen_random_uuid() rather than that migration's uuidv7() default —
-- same convention every other table in this file already follows; the column itself is a plain
-- uuid either way).
create table if not exists platform.tutorial_progress (
  tutorial_progress_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references iam.user_master (user_id),
  role varchar(60) not null,
  lesson_id varchar(120) not null,
  status varchar(30) not null default 'not_started',
  step_index integer not null default 0,
  tutorial_version integer not null default 1,
  started_at timestamptz,
  completed_at timestamptz,
  last_seen_at timestamptz,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.stock_req_items (
  stock_req_item_id uuid primary key default gen_random_uuid(),
  stock_requirement_id uuid references procurement.stock_requirement(stock_requirement_id),
  material_id uuid,
  required_qty numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.vendor_rm_mapping (
  vendor_rm_mapping_id uuid primary key default gen_random_uuid(),
  vendor_id uuid references procurement.vendor_details(vendor_id),
  material_id uuid,
  is_preferred boolean,
  lead_time_days integer,
  min_order_qty numeric(18,3),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

create table if not exists procurement.vendor_credit_reason_master (
  vendor_credit_reason_id uuid primary key default gen_random_uuid(),
  reason_code varchar(50),
  reason_description text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
-- IncomingQcOutcomeService upserts the fixed 'QC_REJECTION' reason via
-- `on conflict (reason_code)` — the unique index IS the conflict target Postgres needs.
create unique index if not exists vendor_credit_reason_master_code_uq
  on procurement.vendor_credit_reason_master (reason_code);

create table if not exists procurement.vendor_credit_note (
  vendor_credit_note_id uuid primary key default gen_random_uuid(),
  vendor_id uuid references procurement.vendor_details(vendor_id),
  grn_id uuid,
  vendor_credit_reason_id uuid references procurement.vendor_credit_reason_master(vendor_credit_reason_id),
  credit_note_number varchar(50),
  credit_note_date date,
  amount numeric(18,4),
  currency_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists vendor_credit_note_number_uq
  on procurement.vendor_credit_note (credit_note_number);

-- platform.notification_log — the EXISTING alerts mechanism (email-notifier.service.ts already
-- writes here); the alerts rule reuses it rather than inventing a second one.
create table if not exists platform.notification_log (
  notification_log_id uuid primary key default gen_random_uuid(),
  event_id uuid unique,
  event_type text,
  channel text,
  recipient text,
  subject text,
  body text,
  status text,
  error text,
  attempts integer not null default 0,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now()
);
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tutorial_progress_user_role_lesson_uq'
  ) then
    alter table platform.tutorial_progress
      add constraint tutorial_progress_user_role_lesson_uq unique (user_id, role, lesson_id);
  end if;
end $$;
create index if not exists tutorial_progress_user_idx on platform.tutorial_progress (user_id);

-- OPS-GREEN Act L (lane ops-factory): scripts/migrations/2026-09-25-factory-weighing-labels.sql
create table if not exists production.weighing_record (
  weighing_record_id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null,
  secure_mixing_session_id uuid not null references production.secure_mixing_session (secure_mixing_session_id),
  sequence_no integer not null,
  floor_code varchar(100) not null,
  target_qty numeric(18,4) not null,
  uom varchar(30),
  gross_qty numeric(18,4) not null,
  tare_qty numeric(18,4) not null,
  net_qty numeric(18,4) not null,
  tolerance_pct numeric(6,3) not null,
  within_tolerance boolean not null,
  scale_ref varchar(100),
  weighed_by uuid,
  weighed_dt timestamptz not null default now(),
  status varchar(30) not null,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
-- The real check, here too: without it a status the migrations refuse passed every test (STOCK2-1).
alter table production.weighing_record drop constraint if exists weighing_record_status_chk;
alter table production.weighing_record add constraint weighing_record_status_chk
  check (status in ('ACCEPTED', 'OUT_OF_TOLERANCE', 'OVER_PICK', 'NOT_BOOKABLE'));
create unique index if not exists weighing_record_accepted_uq
  on production.weighing_record (secure_mixing_session_id, sequence_no) where status = 'ACCEPTED';
create table if not exists packaging.fg_label_record (
  fg_label_record_id uuid primary key default gen_random_uuid(),
  finished_good_batch_id uuid not null references packaging.finished_good_batch_master (finished_good_batch_id),
  label_count integer not null,
  label_content jsonb not null,
  applied_by uuid,
  applied_dt timestamptz not null default now(),
  status varchar(30) not null default 'APPLIED',
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- Lane platform-roles (2026-09-28): the tables scripts/migrations/0014_adhoc_negotiation_advance_
-- dispatch.sql and 0015_adhoc_document_registry.sql create in every real database, copied verbatim,
-- so the restored DispatchDocsService / DocumentsService / ProcAnalyticsService negotiation,
-- vendor-dispatch and advance-payment paths are tested against the production shape.
create table if not exists procurement.vendor_negotiation (
  vendor_negotiation_id uuid primary key default gen_random_uuid(),
  quotation_id uuid, vendor_id uuid, material_id uuid,
  original_rate numeric(18,4), revised_rate numeric(18,4),
  notes text, recommendation text,
  status varchar(30) default 'ACTIVE',
  created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(64), updated_by varchar(64)
);
create table if not exists procurement.po_advance_payment (
  po_advance_payment_id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid, amount numeric(18,2), payment_date date, reference text,
  status varchar(30) default 'PAID',
  created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(64), updated_by varchar(64)
);
create table if not exists procurement.vendor_dispatch (
  vendor_dispatch_id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid, dispatch_date date, transporter text, docket_number text, vehicle_number text,
  status varchar(30) default 'DISPATCHED',
  created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(64), updated_by varchar(64)
);
create table if not exists sales.dispatch_document (
  dispatch_document_id uuid primary key default gen_random_uuid(),
  dispatch_id uuid, sales_order_id uuid, document_type text, document_number text, document_date date,
  amount numeric(18,2), reference text, received_by text, notes text,
  status varchar(30) default 'ISSUED',
  created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(64), updated_by varchar(64)
);
create table if not exists platform.document_registry (
  document_registry_id uuid primary key,
  title text, document_type text, entity_type text, entity_id uuid, reference_no text,
  source_url text, file_name text, version integer not null default 1, supersedes_id uuid,
  issue_date date, expiry_date date, notes text, status text not null default 'ACTIVE',
  created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(64), updated_by varchar(64)
);

-- Lane platform-roles (2026-09-28): iam.login_history exactly as scripts/migrations/2026-09-28-login-history.sql
-- creates it (gen_random_uuid() for this harness's default, as elsewhere in this file), append-only trigger included.
create table if not exists iam.login_history (
  login_history_id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  user_id uuid,
  email varchar(320),
  method varchar(20) not null,
  console varchar(20),
  outcome varchar(10) not null,
  reason_code varchar(60),
  reason varchar(500),
  ip varchar(64),
  user_agent varchar(512),
  session_id uuid,
  constraint login_history_method_ck check (method in ('ALEMBIC_SSO', 'VAULT_STEP_UP', 'PASSWORD')),
  constraint login_history_outcome_ck check (outcome in ('SUCCESS', 'REFUSED')),
  constraint login_history_reason_ck check ((outcome = 'SUCCESS') = (reason_code is null))
);
create index if not exists login_history_occurred_idx on iam.login_history (occurred_at desc, login_history_id desc);
create index if not exists login_history_user_idx on iam.login_history (user_id, occurred_at desc);
create or replace function iam.login_history_append_only()
  returns trigger language plpgsql as $$
  begin
    raise exception 'iam.login_history is append-only — % is blocked', tg_op;
  end $$;
drop trigger if exists login_history_append_only on iam.login_history;
create trigger login_history_append_only
  before update or delete on iam.login_history
  for each row execute function iam.login_history_append_only();
drop trigger if exists login_history_no_truncate on iam.login_history;
create trigger login_history_no_truncate
  before truncate on iam.login_history
  for each statement execute function iam.login_history_append_only();
-- lane compliance-rp (owner rulings 2026-09-28): scripts/migrations/2026-09-28-compliance-documents.sql
-- (main block), hand-matched to packages/data-production/src/schema/coa.ts and
-- packages/data-bridge/src/schema/compliance.ts; plus the two existing tables the COA flow reads
-- (production.production_plan_items for batch → formula → product, platform.document_master for
-- photo references) that this harness had not needed before.
create table if not exists production.production_plan_items (
  production_plan_item_id uuid primary key default gen_random_uuid(),
  production_plan_id uuid,
  formula_id uuid,
  planned_qty numeric(18,4),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create table if not exists platform.document_master (
  document_id uuid primary key default gen_random_uuid(),
  document_type_id uuid,
  file_name varchar(200),
  file_path varchar(255),
  uploaded_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create table if not exists production.product_qc_spec (
  product_qc_spec_id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  sg_min numeric(8,4) not null,
  sg_max numeric(8,4) not null,
  flash_point_min_c numeric(6,1) not null,
  flash_point_max_c numeric(6,1) not null,
  shelf_life_months integer not null,
  colour_appearance_standard text,
  odour_standard text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  constraint product_qc_spec_ranges_chk
    check (sg_min > 0 and sg_min <= sg_max and flash_point_min_c <= flash_point_max_c and shelf_life_months between 1 and 240)
);
create unique index if not exists product_qc_spec_product_uq on production.product_qc_spec (product_id);
create table if not exists production.batch_coa (
  batch_coa_id uuid primary key default gen_random_uuid(),
  oil_batch_id uuid not null,
  product_id uuid not null,
  sg_result numeric(8,4) not null,
  sg_spec_min numeric(8,4) not null,
  sg_spec_max numeric(8,4) not null,
  sg_pass boolean not null,
  flash_point_result_c numeric(6,1) not null,
  flash_point_spec_min_c numeric(6,1) not null,
  flash_point_spec_max_c numeric(6,1) not null,
  flash_point_pass boolean not null,
  colour_appearance text not null,
  colour_appearance_pass boolean not null,
  odour_description text not null,
  odour_pass boolean not null,
  production_date date not null,
  best_before date not null,
  overall_result varchar(10) not null,
  tested_by uuid,
  tested_dt timestamptz not null default now(),
  released_by uuid,
  released_dt timestamptz,
  status varchar(30) not null,
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  constraint batch_coa_state_chk check (
    overall_result in ('PASS', 'FAIL')
    and status in ('TESTED', 'RELEASED')
    and (status <> 'RELEASED' or (overall_result = 'PASS' and released_dt is not null and released_by is not null))
    and best_before > production_date
  )
);
-- Lane produce: QC's FAIL verdict. The state check is replaced exactly as
-- scripts/migrations/2026-09-29-produce.sql replaces it (REJECTED becomes a legal state).
alter table production.batch_coa add column if not exists rejected_by uuid;
alter table production.batch_coa add column if not exists rejected_dt timestamptz;
alter table production.batch_coa add column if not exists reject_reason text;
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'batch_coa_state_chk'
               and pg_get_constraintdef(oid) not like '%REJECTED%') then
    alter table production.batch_coa drop constraint batch_coa_state_chk;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'batch_coa_state_chk') then
    alter table production.batch_coa add constraint batch_coa_state_chk check (
      overall_result in ('PASS', 'FAIL')
      and status in ('TESTED', 'RELEASED', 'REJECTED')
      and (status <> 'RELEASED' or (overall_result = 'PASS' and released_dt is not null and released_by is not null))
      and (status <> 'REJECTED' or (rejected_dt is not null and rejected_by is not null))
      and best_before > production_date
    );
  end if;
end $$;
create unique index if not exists batch_coa_oil_batch_uq on production.batch_coa (oil_batch_id);
create table if not exists production.batch_coa_photo (
  batch_coa_photo_id uuid primary key default gen_random_uuid(),
  batch_coa_id uuid not null references production.batch_coa (batch_coa_id),
  document_id uuid,
  url text,
  caption varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  constraint batch_coa_photo_ref_chk check (document_id is not null or url is not null)
);
create table if not exists bridge.compliance_certificate (
  certificate_id uuid primary key,
  vault_seq bigint not null,
  formula_id uuid not null,
  formula_version_ref varchar(80) not null,
  kind varchar(10) not null,
  amendment varchar(60),
  cert_values jsonb not null,
  calculated_at timestamptz not null,
  received_at timestamptz not null default now()
);
create unique index if not exists bridge_compliance_certificate_seq_uq on bridge.compliance_certificate (vault_seq);
create table if not exists bridge.compliance_certificate_emission (
  emission_id uuid primary key default gen_random_uuid(),
  certificate_id uuid not null,
  product_id uuid not null,
  emitted_at timestamptz not null default now()
);
create unique index if not exists bridge_compliance_certificate_emission_uq
  on bridge.compliance_certificate_emission (certificate_id, product_id);
create table if not exists bridge.vault_sync_cursor (
  id varchar(50) primary key,
  last_seq bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Lane produce (2026-09-29): scripts/migrations/2026-09-29-produce.sql, plus the Phase-1A
-- warehouse hierarchy (location.warehouse/floor/zone/rack/shelf/bin_master, exactly as
-- scripts/migrations/0003_location.sql creates them) which this harness did not carry before.
alter table bridge.production_requirement add column if not exists priority_rank integer;
alter table bridge.production_requirement add column if not exists priority_reason varchar(30);
alter table bridge.production_requirement add column if not exists order_value_inr numeric(18,2);
alter table bridge.production_requirement add column if not exists order_refs jsonb;
alter table bridge.production_requirement add column if not exists qty_kg numeric(18,4);
alter table bridge.production_requirement add column if not exists lot_policy varchar(20);
alter table bridge.production_requirement add column if not exists produce_block_reason varchar(60);
alter table bridge.production_requirement add column if not exists produce_blocked_at timestamptz;
alter table bridge.production_requirement add column if not exists overdue_alerted_at timestamptz;
create index if not exists bridge_production_requirement_queue_idx
  on bridge.production_requirement (priority_rank, needed_by, created_dt);
alter table bridge.compliance_certificate add column if not exists formula_version_number integer;

create table if not exists production.produce_alert (
  produce_alert_id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  kind varchar(40) not null,
  severity varchar(10) not null,
  title text not null,
  detail text,
  roles text[] not null,
  ref_type varchar(40),
  ref_id uuid,
  dedupe_key varchar(200) not null,
  created_at timestamptz not null default now()
);
create unique index if not exists produce_alert_dedupe_uq on production.produce_alert (dedupe_key);
create unique index if not exists produce_alert_seq_uq on production.produce_alert (seq);

create table if not exists packaging.product_dg_info (
  product_dg_info_id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  un_number varchar(10),
  proper_shipping_name text,
  dg_class varchar(10),
  packing_group varchar(5),
  signal_word varchar(20),
  hazard_statements text,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists product_dg_info_product_uq on packaging.product_dg_info (product_id);

create schema if not exists location;
create table if not exists location.warehouse_master (
  warehouse_id uuid primary key default gen_random_uuid(),
  location_id uuid, warehouse_type_id uuid,
  warehouse_code varchar(50), warehouse_name varchar(200),
  status varchar(30), created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(255), updated_by varchar(255)
);
create unique index if not exists warehouse_master_code_uq on location.warehouse_master (warehouse_code);
create table if not exists location.floor_master (
  floor_id uuid primary key default gen_random_uuid(),
  warehouse_id uuid references location.warehouse_master (warehouse_id),
  floor_code varchar(50), floor_name varchar(200),
  status varchar(30), created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(255), updated_by varchar(255)
);
create unique index if not exists floor_master_code_uq on location.floor_master (floor_code);
create table if not exists location.zone_master (
  zone_id uuid primary key default gen_random_uuid(),
  floor_id uuid references location.floor_master (floor_id), zone_type_id uuid,
  zone_code varchar(50), zone_name varchar(200),
  status varchar(30), created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(255), updated_by varchar(255)
);
create unique index if not exists zone_master_code_uq on location.zone_master (zone_code);
create table if not exists location.rack_master (
  rack_id uuid primary key default gen_random_uuid(),
  zone_id uuid references location.zone_master (zone_id),
  rack_code varchar(50), rack_name varchar(200),
  status varchar(30), created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(255), updated_by varchar(255)
);
create unique index if not exists rack_master_code_uq on location.rack_master (rack_code);
create table if not exists location.shelf_master (
  shelf_id uuid primary key default gen_random_uuid(),
  rack_id uuid references location.rack_master (rack_id),
  shelf_code varchar(50), shelf_name varchar(200),
  status varchar(30), created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(255), updated_by varchar(255)
);
create unique index if not exists shelf_master_code_uq on location.shelf_master (shelf_code);
create table if not exists location.bin_master (
  bin_id uuid primary key default gen_random_uuid(),
  shelf_id uuid references location.shelf_master (shelf_id),
  bin_code varchar(50), bin_name varchar(200),
  status varchar(30), created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
  created_by varchar(255), updated_by varchar(255)
);
create unique index if not exists bin_master_code_uq on location.bin_master (bin_code);

create table if not exists location.rack_walk_order (
  rack_id uuid primary key references location.rack_master (rack_id),
  walk_seq integer not null,
  updated_dt timestamptz not null default now(),
  updated_by varchar(255)
);
create table if not exists location.shelf_task (
  shelf_task_id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  kind varchar(10) not null,
  finished_good_batch_id uuid not null,
  product_sku_id uuid,
  qty numeric(18,4) not null,
  uom_id uuid,
  from_bin_id uuid references location.bin_master (bin_id),
  to_bin_id uuid references location.bin_master (bin_id),
  alembic_requirement_id uuid,
  reference varchar(100),
  priority_rank integer,
  completed_by uuid,
  completed_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  constraint shelf_task_shape_chk check (
    kind in ('PUTAWAY', 'PICK', 'MOVE')
    and status in ('OPEN', 'DONE', 'CANCELLED')
    and qty > 0
    and (kind <> 'PICK' or from_bin_id is not null)
    and (kind <> 'MOVE' or (from_bin_id is not null and to_bin_id is not null))
    and (status <> 'DONE' or completed_dt is not null)
  )
);
create unique index if not exists shelf_task_seq_uq on location.shelf_task (seq);
create table if not exists location.fg_bin_stock (
  fg_bin_stock_id uuid primary key default gen_random_uuid(),
  finished_good_batch_id uuid not null,
  bin_id uuid not null references location.bin_master (bin_id),
  qty numeric(18,4) not null,
  uom_id uuid,
  put_away_dt timestamptz not null default now(),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255),
  constraint fg_bin_stock_qty_chk check (qty >= 0)
);
create unique index if not exists fg_bin_stock_batch_bin_uq on location.fg_bin_stock (finished_good_batch_id, bin_id);
create table if not exists location.pick_light_config (
  id varchar(50) primary key default 'default',
  mode varchar(20) not null default 'off',
  controller_url text,
  hmac_secret_sealed text,
  configured_at timestamptz,
  configured_by varchar(255),
  constraint pick_light_config_mode_chk check (mode in ('off', 'simulator', 'http'))
);
create table if not exists location.pick_light_command (
  command_id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  shelf_task_id uuid,
  action varchar(10) not null,
  body jsonb not null,
  status varchar(20) not null default 'PENDING',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  last_http_status integer,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists pick_light_command_seq_uq on location.pick_light_command (seq);
create table if not exists location.pick_light_sim_state (
  location_key varchar(160) primary key,
  rack varchar(50) not null,
  shelf varchar(50),
  bin varchar(50),
  lit boolean not null default false,
  colour varchar(20),
  qty numeric(18,4),
  shelf_task_id uuid,
  signature_ok boolean,
  last_command jsonb,
  updated_at timestamptz not null default now()
);
-- Lane produce: the "Produce next" plan adds items to today's production plan (as
-- scripts/migrations/0008_production.sql creates the table).
create table if not exists production.production_plan (
  production_plan_id uuid primary key default gen_random_uuid(),
  location_id uuid,
  plan_date date,
  planned_start_dt timestamptz,
  planned_end_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
-- Lane catalogue (2026-10-05): scripts/migrations/2026-10-05-factory-setup.sql, verbatim but for
-- the id default (gen_random_uuid() for this harness, as elsewhere in this file).
create table if not exists bridge.catalogue_item (
  alembic_sku_id uuid primary key,
  sku_code varchar(50) not null,
  name text not null,
  category varchar(100),
  classification varchar(20) not null,
  classification_basis text not null,
  grade varchar(50),
  cas_number text,
  cas_source text,
  density_mg_per_ml integer,
  density_source text,
  hazmat jsonb not null default '{}'::jsonb,
  pack_sizes jsonb not null default '[]'::jsonb,
  on_hand_kg numeric(18,4) not null default 0,
  material_id uuid,
  material_owned boolean not null default false,
  rm_alias_id uuid,
  floor_code varchar(30),
  product_id uuid,
  product_sku_id uuid,
  note text,
  first_synced_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  synced_by varchar(255) not null
);
create unique index if not exists catalogue_item_sku_code_uq on bridge.catalogue_item (sku_code);
create index if not exists catalogue_item_product_idx on bridge.catalogue_item (product_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalogue_item_classification_chk') then
    alter table bridge.catalogue_item add constraint catalogue_item_classification_chk
      check (classification in ('single_chemical', 'blend'));
  end if;
  -- A CAS number travels with the source it is held under, or not at all.
  if not exists (select 1 from pg_constraint where conname = 'catalogue_item_cas_sourced_chk') then
    alter table bridge.catalogue_item add constraint catalogue_item_cas_sourced_chk
      check (cas_number is null or (cas_source is not null and btrim(cas_source) <> ''));
  end if;
end $$;

create table if not exists production.setup_proposal (
  setup_proposal_id uuid primary key default gen_random_uuid(),
  kind varchar(20) not null,
  product_id uuid,
  subject_label text not null,
  payload jsonb not null,
  source varchar(20) not null,
  evidence text not null,
  proposer varchar(50) not null default 'Ruh',
  status varchar(20) not null default 'proposed',
  proposed_dt timestamptz not null default now(),
  proposed_by varchar(255),
  decided_by varchar(255),
  decided_dt timestamptz,
  decision_note text,
  applied jsonb
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_kind_chk') then
    alter table production.setup_proposal add constraint setup_proposal_kind_chk check (kind in ('qc_spec', 'rack_layout'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_source_chk') then
    alter table production.setup_proposal add constraint setup_proposal_source_chk check (source in ('document', 'catalogue fact', 'estimate'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_status_chk') then
    alter table production.setup_proposal add constraint setup_proposal_status_chk check (status in ('proposed', 'approved', 'rejected', 'superseded'));
  end if;
  -- A decision has a person and an instant, or it is not a decision.
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_decided_chk') then
    alter table production.setup_proposal add constraint setup_proposal_decided_chk
      check ((status in ('approved', 'rejected')) = (decided_by is not null and decided_dt is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'setup_proposal_qc_has_product_chk') then
    alter table production.setup_proposal add constraint setup_proposal_qc_has_product_chk
      check (kind <> 'qc_spec' or product_id is not null);
  end if;
end $$;
-- One open draft per product (QC) and one open rack layout: asking again never stacks drafts.
create unique index if not exists setup_proposal_open_qc_uq on production.setup_proposal (product_id)
  where status = 'proposed' and kind = 'qc_spec';
create unique index if not exists setup_proposal_open_rack_uq on production.setup_proposal (kind)
  where status = 'proposed' and kind = 'rack_layout';
create index if not exists setup_proposal_status_idx on production.setup_proposal (kind, status);

-- Lane vaultsetup (2026-10-05): packaging.audit_events — @core/data-kernel's auditTable() shape
-- (packages/data-packaging/src/schema/crosscutting.ts). FormulaSetupService (backend/api/src/
-- formula-setup) records every product -> formula link change here, before and after.
create table if not exists packaging.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  ip text,
  occurred_at timestamptz not null default now(),
  chain_seq bigint,
  prev_hash text,
  row_hash text
);

-- Lane ruh-factory (2026-10-06): always-on Ruh — scripts/migrations/2026-10-06-ruh.sql's main block
-- (gen_random_uuid() for uuidv7(), as everywhere in this harness), plus platform.audit_events
-- (@core/data-kernel auditTable() shape), where Ruh records insight decisions and overrides.
create sequence if not exists platform.ruh_insight_rev_seq;
create table if not exists platform.ruh_insight (
  ruh_insight_id uuid primary key default gen_random_uuid(),
  rev bigint not null default nextval('platform.ruh_insight_rev_seq'),
  kind varchar(80) not null,
  severity varchar(10) not null,
  audience_roles text[] not null,
  console varchar(12) not null,
  subject jsonb not null,
  title text not null,
  body text not null,
  deep_link text,
  prediction jsonb,
  source varchar(20) not null,
  dedupe_key varchar(200) not null,
  mirror boolean not null default false,
  status varchar(12) not null default 'open',
  snoozed_until timestamptz,
  acted_by uuid,
  acted_at timestamptz,
  act_note text,
  last_detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ruh_insight_open_dedupe_uq on platform.ruh_insight (dedupe_key)
  where status in ('open', 'snoozed');
create index if not exists ruh_insight_status_idx on platform.ruh_insight (status, severity);
create index if not exists ruh_insight_rev_idx on platform.ruh_insight (rev);
create index if not exists ruh_insight_dedupe_idx on platform.ruh_insight (dedupe_key, created_at);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ruh_insight_shape_chk') then
    alter table platform.ruh_insight add constraint ruh_insight_shape_chk check (
      severity in ('info', 'suggest', 'warn', 'urgent')
      and status in ('open', 'snoozed', 'done', 'dismissed')
      and console in ('factory', 'platform', 'vault')
      and source in ('detector', 'override')
      and (status <> 'snoozed' or snoozed_until is not null)
      and cardinality(audience_roles) > 0
    );
  end if;
end $$;
create table if not exists platform.ruh_setting (
  setting_key varchar(80) primary key,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create table if not exists bridge.ruh_signal (
  ruh_signal_id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  op varchar(10) not null,
  dedupe_key varchar(200) not null,
  payload jsonb,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  parked_at timestamptz,
  last_error text,
  last_http_status integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ruh_signal_pending_uq on bridge.ruh_signal (op, dedupe_key)
  where delivered_at is null and parked_at is null;
create unique index if not exists ruh_signal_seq_uq on bridge.ruh_signal (seq);
create index if not exists ruh_signal_due_idx on bridge.ruh_signal (next_attempt_at)
  where delivered_at is null and parked_at is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ruh_signal_shape_chk') then
    alter table bridge.ruh_signal add constraint ruh_signal_shape_chk check (
      op in ('signal', 'resolve') and (op <> 'signal' or payload is not null)
    );
  end if;
end $$;
create table if not exists platform.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  ip text,
  occurred_at timestamptz not null default now(),
  chain_seq bigint,
  prev_hash text,
  row_hash text
);

-- SALES-REQUEST-BRIDGE (2026-10-27): scripts/migrations/2026-10-27-sales-request.sql.
alter table bridge.production_requirement add column if not exists origin varchar(20) not null default 'order';
alter table bridge.production_requirement add column if not exists request_ref varchar(100);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bridge_production_requirement_origin_chk') then
    alter table bridge.production_requirement add constraint bridge_production_requirement_origin_chk
      check (origin in ('order', 'sales_request')
             and (origin <> 'sales_request' or (request_ref is not null and btrim(request_ref) <> '')));
  end if;
end $$;

-- FACTORY-DEFECTS: scripts/migrations/2026-11-02-production-order-number.sql, mirrored here.
ALTER TABLE production.production_order ADD COLUMN IF NOT EXISTS order_number varchar(40);
CREATE UNIQUE INDEX IF NOT EXISTS production_order_order_number_uq ON production.production_order (order_number);

-- PROD-A (lane pf-a): scripts/migrations/2026-11-05-pfa-floor.sql, mirrored here (grants omitted).

create table if not exists platform.policy (
  policy_key   varchar(60) primary key,
  title        varchar(200) not null,
  description  text,
  created_dt   timestamptz not null default now()
);

create table if not exists platform.policy_version (
  policy_key    varchar(60) not null references platform.policy(policy_key),
  version       integer     not null check (version >= 1),
  body          jsonb       not null,
  reason        text        not null check (btrim(reason) <> ''),
  created_by    varchar(255) not null,
  created_dt    timestamptz not null default now(),
  primary key (policy_key, version)
);

create table if not exists platform.policy_override (
  override_id   uuid primary key default gen_random_uuid(),
  policy_key    varchar(60) not null references platform.policy(policy_key),
  record_type   varchar(60) not null,
  record_id     varchar(100) not null,
  value         jsonb       not null,
  reason        text        not null check (btrim(reason) <> ''),
  created_by    varchar(255) not null,
  created_dt    timestamptz not null default now(),
  revoked_by    varchar(255),
  revoked_dt    timestamptz,
  revoke_reason text
);
create unique index if not exists policy_override_active_uq
  on platform.policy_override (policy_key, record_type, record_id) where revoked_dt is null;

create table if not exists platform.policy_decision (
  decision_id   uuid primary key default gen_random_uuid(),
  policy_key    varchar(60) not null,
  version       integer     not null,
  rule_id       varchar(100),
  record_type   varchar(60),
  record_id     varchar(100),
  ctx           jsonb       not null,
  value         jsonb,
  explain       text        not null,
  decided_by    varchar(255),
  decided_dt    timestamptz not null default now()
);
create index if not exists policy_decision_record_idx on platform.policy_decision (record_type, record_id);

-- The five policies the plan names. Two ship a default the owner set in §12 (floor.queue strict
-- alternation, receiving.shortfall 20% / 5%, qc.rework max 2). procurement.payment_terms and
-- planning.cover ship WITHOUT one: until an admin publishes rules, those hold and ask.
insert into platform.policy (policy_key, title, description) values
  ('floor.queue', 'Floor queue order', 'Which job the floor makes next. Default: strict alternation New, Delayed, New ...'),
  ('receiving.shortfall', 'Delivery shortfall and extra', 'When a short or over delivery is rejected or held.'),
  ('procurement.payment_terms', 'Supplier payment terms', 'Advance on approval, against GRN, or credit terms.'),
  ('planning.cover', 'Stock cover', 'How much finished stock to plan to hold.'),
  ('qc.rework', 'QC rework limit', 'How many reworks a batch may have before review.')
on conflict (policy_key) do nothing;

insert into platform.policy_version (policy_key, version, body, reason, created_by) values
  ('floor.queue', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"mode":"alternate"}}', 'Owner decision 2026-11-05 (plan 12.3): strict alternation', 'system'),
  ('receiving.shortfall', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"basis":"po","shortPct":20,"extraPct":5}}', 'Owner decision 2026-11-05 (plan 12.1)', 'system'),
  ('qc.rework', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"maxReworks":2}}', 'Owner decision 2026-11-05 (plan 12.7)', 'system'),
  ('procurement.payment_terms', 1, '{"rules":[],"hasDefault":false}', 'No default: hold and ask until rules are published', 'system'),
  ('planning.cover', 1, '{"rules":[],"hasDefault":false}', 'No default: hold and ask until rules are published', 'system')
on conflict (policy_key, version) do nothing;

create table if not exists masterdata.floor_family_colour (
  family_code   varchar(30) primary key,
  family_name   varchar(100) not null,
  colour_name   varchar(30)  not null,
  colour_hex    char(7)      not null check (colour_hex ~ '^#[0-9A-Fa-f]{6}$'),
  initial       char(1)      not null,
  updated_by    varchar(255),
  updated_dt    timestamptz not null default now()
);
create unique index if not exists floor_family_colour_name_uq on masterdata.floor_family_colour (upper(colour_name));

create table if not exists masterdata.floor_code (
  material_id   uuid primary key,
  family_code   varchar(30) not null references masterdata.floor_family_colour(family_code),
  number        integer     not null check (number between 1 and 9999),
  created_by    varchar(255),
  created_dt    timestamptz not null default now(),
  unique (family_code, number)
);

create table if not exists inventory.lot_barcode (
  barcode            varchar(12) primary key check (barcode ~ '^L-[0-9A-HJKMNP-TV-Z]{7}$'),
  inventory_batch_id uuid not null unique,
  created_by         varchar(255),
  created_dt         timestamptz not null default now()
);

create table if not exists production.floor_job (
  floor_job_id          uuid primary key default gen_random_uuid(),
  job_no                varchar(20) not null unique,
  production_order_id   uuid not null unique,
  material_pick_list_id uuid not null,
  stage                 varchar(12) not null default 'PICK' check (stage in ('PICK', 'VERIFY', 'MIX', 'DONE')),
  promise_dt            timestamptz,
  expedite              boolean not null default false,
  order_ref             varchar(100),
  channel               varchar(30),
  customer_tier         varchar(30),
  tote                  varchar(30),
  picked_by             varchar(255),
  picked_dt             timestamptz,
  verified_by           varchar(255),
  verified_dt           timestamptz,
  mixed_by              varchar(255),
  mixed_dt              timestamptz,
  batch_no              varchar(40),
  mixing_session_id     uuid,
  oil_batch_id          uuid,
  created_by            varchar(255),
  created_dt            timestamptz not null default now()
);
create sequence if not exists production.floor_job_no_seq;

create table if not exists production.floor_line (
  floor_line_id              uuid primary key default gen_random_uuid(),
  floor_job_id               uuid not null references production.floor_job(floor_job_id),
  material_pick_list_item_id uuid not null unique,
  material_id                uuid not null,
  seq                        integer not null,
  target_mg                  bigint not null check (target_mg > 0),
  tolerance_ppm              integer not null default 10000 check (tolerance_ppm between 0 and 1000000),
  picked_batch_id            uuid,
  picked_mg                  bigint,
  pick_off_fefo_reason       text,
  picked_by                  varchar(255),
  picked_dt                  timestamptz,
  actual_mg                  bigint,
  weigh_source               varchar(10) check (weigh_source in ('typed', 'scale')),
  verified_by                varchar(255),
  verified_dt                timestamptz,
  debited_mg                 bigint,
  over_mg                    bigint,
  over_source                varchar(10),
  over_read_by               varchar(255),
  over_reason                text,
  over_by                    varchar(255),
  over_dt                    timestamptz,
  unique (floor_job_id, seq)
);
alter table production.floor_line add column if not exists debited_mg bigint;
alter table production.floor_line add column if not exists over_mg bigint;
alter table production.floor_line add column if not exists over_source varchar(10);
alter table production.floor_line add column if not exists over_read_by varchar(255);
alter table production.floor_line add column if not exists over_reason text;
alter table production.floor_line add column if not exists over_by varchar(255);
alter table production.floor_line add column if not exists over_dt timestamptz;

create table if not exists production.floor_mix_step (
  floor_job_id  uuid not null references production.floor_job(floor_job_id),
  seq           integer not null,
  instruction   text not null,
  done_by       varchar(255),
  done_dt       timestamptz,
  primary key (floor_job_id, seq)
);

create table if not exists production.floor_label (
  floor_label_id uuid primary key default gen_random_uuid(),
  floor_job_id   uuid not null references production.floor_job(floor_job_id),
  kind           varchar(10) not null check (kind in ('PICKED', 'VERIFIED', 'MIXED')),
  reprint        boolean not null default false,
  reason         text,
  printed_by     varchar(255) not null,
  printed_dt     timestamptz not null default now(),
  check (not reprint or (reason is not null and btrim(reason) <> ''))
);

-- PROD-B: two tables the pfb migration extends/reads that this slice never had, column-matched to
-- scripts/migrations/0007_quality.sql and 0006_inventory.sql (default gen_random_uuid: no uuidv7() here).
create table if not exists quality.qc_parameter_master (
  qc_parameter_id uuid primary key default gen_random_uuid(),
  parameter_code varchar(50),
  parameter_name varchar(200),
  uom_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists qc_parameter_master_code_uq on quality.qc_parameter_master (parameter_code);
create table if not exists inventory.batch_genealogy_history (
  batch_genealogy_history_id uuid primary key default gen_random_uuid(),
  finished_good_batch_id uuid,
  oil_batch_id uuid,
  rm_batch_id uuid,
  relationship_type varchar(30),
  recorded_dt timestamptz,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
-- PROD-B: scripts/migrations/2026-11-05-pfb-inbound-qc.sql, mirrored here (body after @target).

alter table inventory.gate_entry_master add column if not exists hold_reason text;

create table if not exists inventory.receiving_audit (
  receiving_audit_id  uuid primary key default gen_random_uuid(),
  gate_entry_id       uuid not null,
  purchase_order_id   uuid not null,
  grn_id              uuid,
  delivery_no         integer not null check (delivery_no >= 1),
  final_delivery      boolean not null default false,
  scope               varchar(4) not null check (scope in ('PO', 'LINE')),
  short_reject_bps    integer not null check (short_reject_bps between 0 and 10000),
  extra_hold_bps      integer not null check (extra_hold_bps between 0 and 100000),
  policy_rule_id      text,
  policy_version      integer not null,
  policy_explain      text not null,
  status              varchar(20) not null default 'SUBMITTED',
  created_dt          timestamptz not null default now(),
  created_by          varchar(255)
);
-- One audit per gate entry: a second submit of the same truck is refused, not a second GRN.
create unique index if not exists receiving_audit_gate_uq on inventory.receiving_audit (gate_entry_id);
create index if not exists receiving_audit_po_idx on inventory.receiving_audit (purchase_order_id);

create table if not exists inventory.receiving_audit_line (
  receiving_audit_line_id  uuid primary key default gen_random_uuid(),
  receiving_audit_id       uuid not null references inventory.receiving_audit(receiving_audit_id),
  purchase_order_item_id   uuid not null,
  material_id              uuid,
  base_unit                varchar(4) not null check (base_unit in ('mg', 'unit')),
  ordered_base             bigint not null check (ordered_base >= 0),
  received_base            bigint not null check (received_base >= 0),
  damaged_base             bigint not null default 0 check (damaged_base >= 0),
  cumulative_received_base bigint not null check (cumulative_received_base >= 0),
  checks                   jsonb not null,
  decision                 varchar(20) not null
                           check (decision in ('ACCEPT', 'ACCEPT_SHORT', 'PENDING_BALANCE', 'REJECT_LINE', 'EXCESS_HELD')),
  accepted_base            bigint not null check (accepted_base >= 0),
  rejected_base            bigint not null check (rejected_base >= 0),
  excess_held_base         bigint not null default 0 check (excess_held_base >= 0),
  short_base               bigint not null default 0 check (short_base >= 0),
  overridden               boolean not null default false,
  override_reason          text,
  overridden_by            varchar(255),
  explain                  text not null,
  created_dt               timestamptz not null default now(),
  constraint receiving_audit_line_split_chk check (accepted_base + rejected_base + excess_held_base = received_base),
  constraint receiving_audit_line_override_chk check (not overridden or (override_reason is not null and length(trim(override_reason)) > 0))
);
create index if not exists receiving_audit_line_audit_idx on inventory.receiving_audit_line (receiving_audit_id);
create index if not exists receiving_audit_line_poi_idx on inventory.receiving_audit_line (purchase_order_item_id);

create table if not exists procurement.debit_note (
  debit_note_id      uuid primary key default gen_random_uuid(),
  debit_note_number  varchar(40) not null,
  purchase_order_id  uuid not null,
  vendor_id          uuid,
  receiving_audit_id uuid,
  amount_paise       bigint not null check (amount_paise > 0),
  reason             text not null,
  lines              jsonb not null,
  status             varchar(20) not null default 'RAISED',
  created_dt         timestamptz not null default now(),
  created_by         varchar(255)
);
create unique index if not exists debit_note_number_uq on procurement.debit_note (debit_note_number);
create index if not exists debit_note_po_idx on procurement.debit_note (purchase_order_id);

create table if not exists procurement.po_payment_release (
  po_payment_release_id uuid primary key default gen_random_uuid(),
  purchase_order_id     uuid not null,
  kind                  varchar(10) not null check (kind in ('ADVANCE', 'BALANCE')),
  amount_paise          bigint not null check (amount_paise > 0),
  terms                 jsonb not null,
  policy_rule_id        text,
  policy_version        integer not null,
  status                varchar(12) not null check (status in ('REQUESTED', 'APPROVED', 'RELEASED', 'REFUSED')),
  requested_by          varchar(255) not null,
  requested_dt          timestamptz not null default now(),
  approved_by           varchar(255),
  approved_dt           timestamptz,
  released_by           varchar(255),
  released_dt           timestamptz,
  utr                   varchar(64),
  due_date              date,
  note                  text,
  constraint po_payment_release_utr_chk check (status <> 'RELEASED' or (utr is not null and length(trim(utr)) > 0)),
  constraint po_payment_release_checker_chk check (approved_by is null or approved_by <> requested_by)
);
create index if not exists po_payment_release_po_idx on procurement.po_payment_release (purchase_order_id);
-- A bank reference pays one release: the same UTR typed twice is a mistake, not a second payment.
create unique index if not exists po_payment_release_utr_uq on procurement.po_payment_release (upper(utr)) where utr is not null;

alter table quality.qc_parameter_master add column if not exists check_type varchar(12);
alter table quality.qc_parameter_master add column if not exists instrument text;
alter table quality.qc_parameter_master add column if not exists critical_default boolean;
alter table quality.qc_parameter_master add column if not exists photo_required_default boolean;

create table if not exists quality.qc_checkpoint_set (
  qc_checkpoint_set_id uuid primary key default gen_random_uuid(),
  product_id           uuid not null,
  version              integer not null check (version >= 1),
  reason               text not null,
  published_by         varchar(255),
  published_dt         timestamptz not null default now()
);
create unique index if not exists qc_checkpoint_set_product_version_uq on quality.qc_checkpoint_set (product_id, version);

create table if not exists quality.qc_checkpoint (
  qc_checkpoint_id     uuid primary key default gen_random_uuid(),
  qc_checkpoint_set_id uuid not null references quality.qc_checkpoint_set(qc_checkpoint_set_id),
  seq                  integer not null,
  qc_parameter_id      uuid,
  name                 text not null,
  check_type           varchar(12) not null check (check_type in ('PASS_FAIL', 'RANGE', 'REFERENCE')),
  min_value            numeric(18,6),
  max_value            numeric(18,6),
  reference_text       text,
  critical             boolean not null default false,
  photo_required       boolean not null default false,
  instrument           text,
  constraint qc_checkpoint_range_chk check (check_type <> 'RANGE' or (min_value is not null and max_value is not null and min_value <= max_value))
);
create unique index if not exists qc_checkpoint_set_seq_uq on quality.qc_checkpoint (qc_checkpoint_set_id, seq);

alter table production.product_qc_spec add column if not exists qc_checkpoint_set_id uuid;

create table if not exists quality.batch_qc_round (
  batch_qc_round_id    uuid primary key default gen_random_uuid(),
  oil_batch_id         uuid not null,
  round_no             integer not null check (round_no >= 1),
  qc_checkpoint_set_id uuid not null,
  inspector_id         varchar(255) not null,
  results              jsonb not null,
  defect_type          varchar(30),
  instrument_doubt     boolean not null default false,
  decision             varchar(16) not null
                       check (decision in ('APPROVE', 'REWORK', 'HOLD_RETEST', 'REJECT', 'REVIEW', 'HOLD_CAPA')),
  reasons              jsonb not null,
  rework_no            integer not null default 0,
  qc_capa_id           uuid,
  policy_rule_id       text,
  policy_version       integer not null,
  created_dt           timestamptz not null default now()
);
create unique index if not exists batch_qc_round_batch_round_uq on quality.batch_qc_round (oil_batch_id, round_no);

create table if not exists quality.batch_rework (
  batch_rework_id   uuid primary key default gen_random_uuid(),
  oil_batch_id      uuid not null,
  rework_no         integer not null check (rework_no >= 1),
  batch_qc_round_id uuid not null,
  adjustment_mg     bigint not null check (adjustment_mg >= 0),
  rm_batch_id       uuid,
  note              text not null,
  created_by        varchar(255),
  created_dt        timestamptz not null default now()
);
create unique index if not exists batch_rework_batch_no_uq on quality.batch_rework (oil_batch_id, rework_no);

create table if not exists inventory.lot_hold (
  lot_hold_id    uuid primary key default gen_random_uuid(),
  subject_type   varchar(12) not null check (subject_type in ('RM_LOT', 'OIL_BATCH')),
  subject_id     uuid not null,
  reason         text not null,
  source         varchar(30) not null,
  held_by        varchar(255),
  held_dt        timestamptz not null default now(),
  released_by    varchar(255),
  released_dt    timestamptz,
  release_reason text
);
create unique index if not exists lot_hold_active_uq on inventory.lot_hold (subject_type, subject_id) where released_dt is null;

create table if not exists inventory.raw_lot_label (
  raw_lot_label_id    uuid primary key default gen_random_uuid(),
  rm_batch_id         uuid not null,
  storage_location_id uuid,
  payload             jsonb not null,
  reprint             boolean not null default false,
  printed_by          varchar(255),
  printed_dt          timestamptz not null default now()
);
create index if not exists raw_lot_label_batch_idx on inventory.raw_lot_label (rm_batch_id);

-- The application role (DB_APP_ROLE, passed as rawprod.app_role); same pattern as 2026-11-03-idempotency-key.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'pfb grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'pfb grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant select, insert, update on inventory.receiving_audit, inventory.receiving_audit_line, inventory.lot_hold, inventory.raw_lot_label to %I', app);
  execute format('grant select, insert, update on procurement.debit_note, procurement.po_payment_release to %I', app);
  execute format('grant select, insert, update on quality.qc_checkpoint_set, quality.qc_checkpoint, quality.batch_qc_round, quality.batch_rework to %I', app);
end $$;

-- Lane pf-c (2026-11-05): scripts/migrations/2026-11-05-pfc-floor.sql mirrored here (gen_random_uuid() for
-- uuidv7(), as everywhere in this harness; the app-role grant block is left out).

create table if not exists platform.device_master (
  device_id     uuid primary key default gen_random_uuid(),
  kind          varchar(20)  not null check (kind in ('label_printer', 'display', 'kiosk', 'scale')),
  station       varchar(80)  not null,
  site          varchar(80),
  name          varchar(120) not null,
  status        varchar(12)  not null default 'pending' check (status in ('pending', 'active', 'offline', 'revoked')),
  config        jsonb        not null default '{}'::jsonb,
  last_seen_at  timestamptz,
  paired_at     timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  created_by    uuid,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now()
);
create index if not exists device_master_station_idx on platform.device_master (station, kind);

create table if not exists platform.device_pairing (
  pairing_id  uuid primary key default gen_random_uuid(),
  device_id   uuid        not null references platform.device_master (device_id),
  code_hash   char(64)    not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  attempts    integer     not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create unique index if not exists device_pairing_open_code_uq on platform.device_pairing (code_hash) where used_at is null;

create table if not exists platform.device_token (
  device_token_id uuid primary key default gen_random_uuid(),
  device_id       uuid        not null references platform.device_master (device_id),
  station         varchar(80) not null,
  token_hash      char(64)    not null unique,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
create index if not exists device_token_device_idx on platform.device_token (device_id);

create table if not exists platform.print_job (
  print_job_id    uuid primary key default gen_random_uuid(),
  device_id       uuid,
  station         varchar(80)  not null,
  label_kind      varchar(30)  not null,
  subject_ref     varchar(120),
  template        jsonb        not null,
  status          varchar(10)  not null default 'queued' check (status in ('queued', 'sent', 'printed', 'failed', 'parked', 'browser', 'cancelled')),
  attempts        integer      not null default 0,
  max_attempts    integer      not null default 5,
  next_attempt_at timestamptz  not null default now(),
  last_error      text,
  reprint_of      uuid,
  reprint_reason  text,
  requested_by    uuid,
  printed_at      timestamptz,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now(),
  constraint print_job_reprint_reason_chk check (reprint_of is null or length(trim(coalesce(reprint_reason, ''))) > 0)
);
create index if not exists print_job_pull_idx on platform.print_job (device_id, status, next_attempt_at);
create index if not exists print_job_subject_idx on platform.print_job (label_kind, subject_ref);

create table if not exists platform.scale_reading (
  scale_reading_id uuid primary key default gen_random_uuid(),
  device_id        uuid        not null references platform.device_master (device_id),
  station          varchar(80) not null,
  mg               bigint      not null check (mg >= 0),
  stable           boolean     not null check (stable),
  raw              varchar(200),
  read_at          timestamptz not null default now()
);
create index if not exists scale_reading_device_idx on platform.scale_reading (device_id, read_at desc);

create table if not exists platform.floor_alert (
  floor_alert_id uuid primary key default gen_random_uuid(),
  kind           varchar(40)  not null,
  station        varchar(80),
  subject_type   varchar(40),
  subject_id     uuid,
  title          text         not null,
  body           text,
  dedupe_key     varchar(200) not null,
  raised_at      timestamptz  not null default now(),
  acked_at       timestamptz,
  acked_by       uuid,
  cleared_at     timestamptz
);
create unique index if not exists floor_alert_open_uq on platform.floor_alert (dedupe_key) where cleared_at is null;

create table if not exists production.maceration_setting (
  formula_id      uuid primary key,
  required        boolean     not null default false,
  min_days        integer     not null check (min_days between 1 and 365),
  max_days        integer     not null check (max_days between 1 and 365),
  freeze_required boolean     not null default false,
  freeze_note     varchar(300),
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  constraint maceration_setting_window_chk check (min_days <= max_days)
);

create table if not exists production.maceration_run (
  maceration_run_id    uuid primary key default gen_random_uuid(),
  oil_batch_id         uuid        not null,
  formula_id           uuid,
  status               varchar(16) not null default 'MACERATING' check (status in ('MACERATING', 'CLOSED', 'CANCELLED')),
  started_at           timestamptz not null,
  min_days             integer     not null,
  max_days             integer     not null,
  extend_days          integer     not null default 0,
  freeze_required      boolean     not null default false,
  qc1_production_qc_id uuid        not null,
  freeze_done_at       timestamptz,
  freeze_done_by       uuid,
  alarm_at             timestamptz,
  early_release_at     timestamptz,
  early_release_by     uuid,
  early_release_reason text,
  restart_count        integer     not null default 0,
  closed_at            timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists maceration_run_open_uq on production.maceration_run (oil_batch_id) where status = 'MACERATING';

create table if not exists production.maceration_event (
  maceration_event_id uuid primary key default gen_random_uuid(),
  maceration_run_id   uuid        not null references production.maceration_run (maceration_run_id),
  event               varchar(30) not null,
  note                text,
  performed_by        uuid,
  created_at          timestamptz not null default now()
);
create index if not exists maceration_event_run_idx on production.maceration_event (maceration_run_id, created_at);

create table if not exists sales.shipment (
  shipment_id     uuid primary key default gen_random_uuid(),
  shipment_no     varchar(30)  not null unique,
  sales_order_id  uuid         not null,
  status          varchar(14)  not null default 'PACKING' check (status in ('PACKING', 'PACKED', 'DOCS_READY', 'AWB_ASSIGNED', 'HANDING_OVER', 'HANDED_OVER', 'HOLD', 'CANCELLED')),
  lots            uuid[]       not null,
  carton_count    integer,
  docs            jsonb,
  courier_code    varchar(40),
  awb             varchar(60),
  awb_source      varchar(6) check (awb_source is null or awb_source in ('scan', 'typed')),
  awb_at          timestamptz,
  dispatch_id     uuid,
  handed_over_at  timestamptz,
  handed_over_to  varchar(120),
  handed_over_by  uuid,
  hold_reason     text,
  packed_at       timestamptz,
  packed_by       uuid,
  created_by      uuid,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now()
);
create unique index if not exists shipment_awb_uq on sales.shipment (upper(awb)) where awb is not null;
create index if not exists shipment_status_idx on sales.shipment (status, created_at);

create table if not exists sales.shipment_carton (
  carton_id     uuid primary key default gen_random_uuid(),
  shipment_id   uuid        not null references sales.shipment (shipment_id),
  seq           integer     not null,
  carton_code   varchar(40) not null unique,
  status        varchar(8)  not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  gross_mg      bigint check (gross_mg is null or gross_mg > 0),
  weight_source varchar(6) check (weight_source is null or weight_source in ('scale', 'typed')),
  closed_at     timestamptz,
  closed_by     uuid,
  checked_at    timestamptz,
  checked_by    uuid,
  created_at    timestamptz not null default now(),
  unique (shipment_id, seq)
);

create table if not exists sales.shipment_unit (
  unit_id                uuid primary key default gen_random_uuid(),
  unit_code              varchar(40) not null unique,
  shipment_id            uuid        not null references sales.shipment (shipment_id),
  sales_order_id         uuid        not null,
  sales_order_item_id    uuid,
  finished_good_batch_id uuid        not null,
  batch_number           varchar(50),
  target_mg              bigint      not null check (target_mg > 0),
  tolerance_mg           bigint      not null check (tolerance_mg >= 0),
  net_mg                 bigint      not null check (net_mg > 0),
  weight_source          varchar(6)  not null check (weight_source in ('scale', 'typed')),
  scale_reading_id       uuid,
  sealed                 boolean     not null check (sealed),
  carton_id              uuid references sales.shipment_carton (carton_id),
  carton_scanned_at      timestamptz,
  packed_by              uuid,
  created_at             timestamptz not null default now()
);
create index if not exists shipment_unit_shipment_idx on sales.shipment_unit (shipment_id);

create table if not exists sales.courier_connector (
  provider              varchar(40)  primary key,
  display_name          varchar(120) not null,
  mode                  varchar(5)   not null default 'off' check (mode in ('off', 'test', 'live')),
  credentials_sealed    text,
  awb_pattern           varchar(200),
  tracking_url_template varchar(300),
  health                varchar(12)  not null default 'unknown',
  health_note           text,
  last_sync_at          timestamptz,
  updated_by            uuid,
  updated_at            timestamptz  not null default now()
);


-- PROD-D (lane pf-d): scripts/migrations/2026-11-07-pfd-intelligence.sql mirrored here (body after @target; the app-role grant block is left out).

create table if not exists production.cover_suggestion (
  cover_suggestion_id uuid primary key default gen_random_uuid(),
  sku_code            varchar(50)  not null,
  product_sku_id      uuid,
  qty_units           integer      not null check (qty_units >= 0),
  suggested_units     integer      not null check (suggested_units >= 0),
  reasoning           text         not null check (btrim(reasoning) <> ''),
  inputs              jsonb        not null,
  policy_rule_id      text,
  policy_version      integer      not null,
  status              varchar(12)  not null check (status in ('APPROVED', 'DISMISSED')),
  decided_by          varchar(255) not null,
  decided_dt          timestamptz  not null default now(),
  note                text,
  purchase_request_ids jsonb       not null default '[]'::jsonb,
  floor_job_id        uuid,
  constraint cover_suggestion_note_chk check (status <> 'DISMISSED' or (note is not null and btrim(note) <> ''))
);
create index if not exists cover_suggestion_sku_idx on production.cover_suggestion (sku_code, decided_dt desc);

create table if not exists production.cover_order_flag (
  order_ref   varchar(100) primary key,
  flag        varchar(10)  not null check (flag in ('RECURRING', 'EXCLUDE')),
  reason      text         not null check (btrim(reason) <> ''),
  set_by      varchar(255) not null,
  set_dt      timestamptz  not null default now()
);

alter table production.floor_job add column if not exists source varchar(10) not null default 'ORDER';
alter table production.floor_job add column if not exists cover_suggestion_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'floor_job_source_chk') then
    alter table production.floor_job add constraint floor_job_source_chk check (source in ('ORDER', 'SUGGESTED'));
  end if;
end $$;

create table if not exists production.product_downgrade_target (
  product_id         uuid primary key,
  target_product_id  uuid,
  target_grade       varchar(100),
  reason             text         not null check (btrim(reason) <> ''),
  set_by             varchar(255) not null,
  set_dt             timestamptz  not null default now(),
  constraint product_downgrade_target_one_chk check (target_product_id is not null or (target_grade is not null and btrim(target_grade) <> '')),
  constraint product_downgrade_target_self_chk check (target_product_id is null or target_product_id <> product_id)
);

create table if not exists production.formula_reblend_rule (
  formula_id       uuid primary key,
  reblend_allowed  boolean      not null,
  max_share_bps    integer      check (max_share_bps between 1 and 10000),
  reason           text         not null check (btrim(reason) <> ''),
  set_by           varchar(255) not null,
  set_dt           timestamptz  not null default now(),
  constraint formula_reblend_rule_share_chk check (not reblend_allowed or max_share_bps is not null)
);

create table if not exists quality.batch_review_decision (
  batch_review_decision_id uuid primary key default gen_random_uuid(),
  oil_batch_id        uuid         not null,
  batch_qc_round_id   uuid         not null,
  outcome             varchar(10)  not null check (outcome in ('REJECT', 'DOWNGRADE', 'REBLEND')),
  reason              text         not null check (btrim(reason) <> ''),
  target_product_id   uuid,
  target_grade        varchar(100),
  reblend_into_oil_batch_id uuid,
  reblend_share_bps   integer      check (reblend_share_bps between 1 and 10000),
  status              varchar(10)  not null default 'PROPOSED' check (status in ('PROPOSED', 'CONFIRMED', 'WITHDRAWN')),
  proposed_by         varchar(255) not null,
  proposed_as         varchar(10)  not null check (proposed_as in ('PERFUMER', 'APPROVER')),
  proposed_dt         timestamptz  not null default now(),
  confirmed_by        varchar(255),
  confirmed_as        varchar(10)  check (confirmed_as in ('PERFUMER', 'APPROVER')),
  confirmed_dt        timestamptz,
  withdrawn_reason    text,
  qc_capa_id          uuid,
  constraint batch_review_two_people_chk check (confirmed_by is null or (confirmed_by <> proposed_by and confirmed_as <> proposed_as))
);
-- One live decision per batch: a second proposal while one waits is refused, not stacked.
create unique index if not exists batch_review_decision_live_uq on quality.batch_review_decision (oil_batch_id) where status in ('PROPOSED', 'CONFIRMED');

-- WALK2-RP-11: the raw-lot label resolves its bin by code, exactly as scripts/migrations/0003_location.sql
-- creates the table.
create table if not exists location.storage_location_master (
  storage_location_id uuid primary key default gen_random_uuid() not null,
  warehouse_id uuid, floor_id uuid, zone_id uuid, rack_id uuid, shelf_id uuid, bin_id uuid,
  storage_location_code varchar(50), storage_location_name varchar(200), status varchar(30),
  created_dt timestamptz default now() not null, updated_dt timestamptz default now() not null,
  created_by varchar(255), updated_by varchar(255)
);

-- SCAN-4 (2026-11-07): scripts/migrations/2026-11-07-scan-scanner-kind.sql mirrored here.
alter table platform.device_master drop constraint if exists device_master_kind_check;
alter table platform.device_master add constraint device_master_kind_check
  check (kind in ('label_printer', 'display', 'kiosk', 'scale', 'scanner'));

-- FLOOR-GAPS (2026-11-07): the stock ledger table exactly as scripts/migrations/0006_inventory.sql creates it
-- (a lot split writes one row per side; gen_random_uuid for uuidv7, as everywhere here), then scripts/migrations/2026-11-07-floor-gaps.sql mirrored here
-- (body after @target; the app-role grant block is left out).
CREATE TABLE IF NOT EXISTS "inventory"."inventory_transaction_type_master" (
	"inventory_transaction_type_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_code" varchar(50),
	"type_name" varchar(200)
);
CREATE TABLE IF NOT EXISTS "inventory"."inventory_transaction" (
	"inventory_transaction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_batch_id" uuid,
	"inventory_transaction_type_id" uuid,
	"transaction_qty" numeric(18, 4),
	"uom_id" uuid,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"transaction_dt" timestamp with time zone,
	"reference_document_id" uuid,
	"status" varchar(30),
	"created_dt" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_dt" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(255),
	"updated_by" varchar(255)
);
create table if not exists inventory.lot_split (
  lot_split_id              uuid primary key default gen_random_uuid(),
  kind                      varchar(10) not null check (kind in ('SPLIT', 'RETURN')),
  parent_inventory_batch_id uuid not null,
  child_inventory_batch_id  uuid not null unique,
  rm_batch_id               uuid not null,
  qty_mg                    bigint not null check (qty_mg > 0),
  parent_before_mg          bigint not null check (parent_before_mg >= qty_mg),
  from_location_id          uuid,
  to_location_id            uuid not null,
  floor_job_id              uuid,
  reason                    text,
  created_by                varchar(255) not null,
  created_dt                timestamptz not null default now(),
  check (parent_inventory_batch_id <> child_inventory_batch_id),
  -- a return from the verifier always names the job it came back from
  check (kind <> 'RETURN' or floor_job_id is not null)
);
create index if not exists lot_split_parent_idx on inventory.lot_split (parent_inventory_batch_id);

create table if not exists inventory.lot_label (
  lot_label_id       uuid primary key default gen_random_uuid(),
  inventory_batch_id uuid not null,
  barcode            varchar(12) not null,
  reprint            boolean not null default false,
  reason             text,
  printed_by         varchar(255) not null,
  printed_dt         timestamptz not null default now(),
  check (not reprint or (reason is not null and btrim(reason) <> ''))
);
create index if not exists lot_label_batch_idx on inventory.lot_label (inventory_batch_id);

create table if not exists location.fg_zone_style (
  zone_id      uuid primary key,
  colour_name  varchar(30) not null check (colour_name ~ '^[A-Za-z]+$'),
  colour_hex   varchar(7)  not null check (colour_hex ~ '^#[0-9A-F]{6}$'),
  initials     varchar(3)  not null check (initials ~ '^[A-Z]{1,3}$'),
  updated_by   varchar(255) not null,
  updated_dt   timestamptz not null default now()
);
create unique index if not exists fg_zone_style_colour_uq on location.fg_zone_style (upper(colour_name));
create unique index if not exists fg_zone_style_initials_uq on location.fg_zone_style (initials);


-- FLOOR-FIX-3: scripts/migrations/2026-11-10-floor-fix-typed-weight-check.sql
create table if not exists platform.typed_weight_check (
  check_id     uuid primary key,
  station      varchar(60)  not null,
  mg           bigint       not null check (mg > 0),
  reason       text,
  typed_by     uuid         not null,
  status       varchar(10)  not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'USED')),
  signed_by    uuid,
  signed_role  varchar(20),
  signed_at    timestamptz,
  used_at      timestamptz,
  used_for     text,
  created_at   timestamptz  not null default now(),
  check (signed_by is null or signed_by <> typed_by),
  check (status = 'PENDING' or (signed_by is not null and signed_at is not null))
);
create index if not exists typed_weight_check_station_idx on platform.typed_weight_check (station, status);


-- FLOOR-QC-IN-1, FLOOR-LOT-STOP-1, FLOOR-TEMP-1: scripts/migrations/2026-11-11-floor-claims.sql (app-role grants left out)
-- FLOOR-QC-IN-1: every incoming-lot QC transition on file (born in quarantine, released, rejected).
-- Append-only: the application role gets SELECT and INSERT, never UPDATE or DELETE.
create table if not exists inventory.lot_qc_event (
  lot_qc_event_id uuid primary key default gen_random_uuid(),
  rm_batch_id     uuid not null,
  event           varchar(20) not null check (event in ('QUARANTINED', 'RELEASED', 'REJECTED')),
  detail          text not null,
  actor           varchar(255) not null,
  at              timestamptz not null default clock_timestamp()
);
create index if not exists lot_qc_event_batch_idx on inventory.lot_qc_event (rm_batch_id, at);

-- FLOOR-LOT-STOP-1: a wrong scan stops the job. One open stop per job; resuming names the supervisor
-- (never the person who scanned) and the reason. The row is the audit record.
create table if not exists production.floor_line_stop (
  floor_line_stop_id uuid primary key default gen_random_uuid(),
  floor_job_id       uuid not null,
  floor_line_id      uuid,
  station            varchar(12) not null check (station in ('PICK')),
  kind               varchar(24) not null check (kind in ('WRONG_MATERIAL', 'UNKNOWN_LOT', 'LOT_NOT_RELEASED', 'LOT_ON_HOLD', 'LOT_EXPIRED')),
  scanned            text not null,
  expected           text,
  detail             text not null,
  stopped_by         varchar(255) not null,
  stopped_dt         timestamptz not null default clock_timestamp(),
  cleared_by         varchar(255),
  cleared_dt         timestamptz,
  clear_reason       text,
  constraint floor_line_stop_clear_chk check (
    (cleared_dt is null and cleared_by is null and clear_reason is null)
    or (cleared_dt is not null and cleared_by is not null and length(trim(clear_reason)) > 0 and cleared_by <> stopped_by))
);
create unique index if not exists floor_line_stop_open_uq on production.floor_line_stop (floor_job_id) where cleared_dt is null;

-- FLOOR-TEMP-1: storage and production zones, the bins in each, and the interval a zone must be logged at.
create table if not exists quality.storage_zone (
  zone_id          uuid primary key default gen_random_uuid(),
  zone_code        varchar(40) not null unique,
  zone_name        varchar(120) not null,
  kind             varchar(12) not null check (kind in ('STORAGE', 'PRODUCTION')),
  log_interval_min integer not null check (log_interval_min between 5 and 1440),
  status           varchar(10) not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  -- The zone's own bounds (e.g. a maceration store kept at 16-20 C), only with the house document that sets them.
  min_centi_c      integer check (min_centi_c between -9999 and 9999),
  max_centi_c      integer check (max_centi_c between -9999 and 9999),
  bounds_source    text,
  created_by       varchar(255) not null,
  created_dt       timestamptz not null default now(),
  constraint storage_zone_bounds_chk check ((min_centi_c is null and max_centi_c is null) or length(trim(coalesce(bounds_source, ''))) > 0),
  constraint storage_zone_order_chk check (min_centi_c is null or max_centi_c is null or min_centi_c < max_centi_c)
);
create table if not exists quality.storage_zone_bin (
  zone_id    uuid not null references quality.storage_zone(zone_id),
  bin_id     uuid not null unique,
  created_by varchar(255) not null,
  created_dt timestamptz not null default now(),
  primary key (zone_id, bin_id)
);
-- A reading in hundredths of a degree C (an integer: 31.25 C is 3125). MANUAL readings name who took
-- them; a SENSOR reading must name its device. Append-only.
create table if not exists quality.temperature_reading (
  temperature_reading_id uuid primary key default gen_random_uuid(),
  zone_id                uuid not null references quality.storage_zone(zone_id),
  centi_c                integer not null check (centi_c between -9999 and 9999),
  source                 varchar(8) not null check (source in ('MANUAL', 'SENSOR')),
  device_id              uuid,
  read_at                timestamptz not null,
  recorded_by            varchar(255) not null,
  recorded_dt            timestamptz not null default clock_timestamp(),
  note                   text,
  constraint temperature_reading_device_chk check (source <> 'SENSOR' or device_id is not null)
);
create index if not exists temperature_reading_zone_idx on quality.temperature_reading (zone_id, read_at desc);
-- A material's storage limits, only where a source says so (SDS section, supplier spec, CoA). One
-- current row per material; a change supersedes the old row, it never rewrites it.
create table if not exists quality.material_temp_limit (
  material_temp_limit_id uuid primary key default gen_random_uuid(),
  material_id            uuid not null,
  min_centi_c            integer check (min_centi_c between -9999 and 9999),
  max_centi_c            integer check (max_centi_c between -9999 and 9999),
  source                 text not null check (length(trim(source)) > 0),
  set_by                 varchar(255) not null,
  set_dt                 timestamptz not null default now(),
  superseded_dt          timestamptz,
  constraint material_temp_limit_bound_chk check (min_centi_c is not null or max_centi_c is not null),
  constraint material_temp_limit_order_chk check (min_centi_c is null or max_centi_c is null or min_centi_c < max_centi_c)
);
create unique index if not exists material_temp_limit_current_uq on quality.material_temp_limit (material_id) where superseded_dt is null;
-- Each lot a reading put outside its material's limit, and the hold that stopped it.
create table if not exists quality.temperature_excursion (
  temperature_excursion_id uuid primary key default gen_random_uuid(),
  temperature_reading_id   uuid not null references quality.temperature_reading(temperature_reading_id),
  zone_id                  uuid not null,
  rm_batch_id              uuid not null,
  inventory_batch_id       uuid not null,
  -- the material limit broken, or null when it was the zone's own bounds (basis says which)
  material_temp_limit_id   uuid references quality.material_temp_limit(material_temp_limit_id),
  basis                    varchar(8) not null check (basis in ('MATERIAL', 'ZONE')),
  centi_c                  integer not null,
  lot_hold_id              uuid,
  raised_dt                timestamptz not null default clock_timestamp()
);
create index if not exists temperature_excursion_zone_idx on quality.temperature_excursion (zone_id, raised_dt desc);

-- FLOOR-QC-IN-1: quality.qc_sample_retention (scripts/migrations/0007_quality.sql) -- an incoming lot's
-- ACCEPT now needs its retained sample, so the harness needs the table (gen_random_uuid() for uuidv7()).
create table if not exists quality.qc_sample_retention (
  qc_sample_retention_id uuid primary key default gen_random_uuid(),
  qc_inspection_id uuid, rm_batch_id uuid, oil_batch_id uuid, sample_code varchar(50), sample_qty numeric(18, 4), uom_id uuid,
  retention_location_id uuid, retained_dt timestamptz, retained_by uuid, retention_expiry_dt timestamptz, status varchar(30),
  created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(), created_by varchar(255), updated_by varchar(255)
);

-- FLOOR-TEMP-1: temp_sensor device kind (scripts/migrations/2026-11-11-floor-claims.sql).
alter table platform.device_master drop constraint if exists device_master_kind_check;
alter table platform.device_master add constraint device_master_kind_check
  check (kind in ('label_printer', 'display', 'kiosk', 'scale', 'scanner', 'temp_sensor'));

-- FLOOR-QC-IN-1-LEGACY: inventory.inventory_status_master exactly as packages/data-inventory/src/schema/inventory-batch.ts
-- defines it, so InventoryViewService.availability (which joins it) runs in this harness.
create table if not exists inventory.inventory_status_master (
  inventory_status_id uuid primary key default gen_random_uuid(),
  status_code varchar(50),
  status_name varchar(200),
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists inventory_status_master_code_uq on inventory.inventory_status_master (status_code);

-- FLOOR-QC-IN-1-LEGACY: schema part of scripts/migrations/2026-11-12-legacy-qc-release.sql (its data block and
-- app-role grant left out; legacy-qc-release.test.ts runs the whole file).
alter table inventory.lot_qc_event add column if not exists released_at timestamptz;
alter table inventory.lot_qc_event add column if not exists released_by varchar(255);
alter table inventory.lot_qc_event add column if not exists source text;
alter table inventory.lot_qc_event drop constraint if exists lot_qc_event_event_check;
alter table inventory.lot_qc_event add constraint lot_qc_event_event_check
  check (event in ('QUARANTINED', 'RELEASED', 'REJECTED', 'LEGACY_RELEASE'));
-- A legacy release always names the record it was taken from.
alter table inventory.lot_qc_event drop constraint if exists lot_qc_event_legacy_source_chk;
alter table inventory.lot_qc_event add constraint lot_qc_event_legacy_source_chk
  check (event <> 'LEGACY_RELEASE' or (source is not null and length(trim(source)) > 0));

create table if not exists inventory.legacy_qc_release_2026_11_12 (
  rm_batch_id          uuid primary key,
  grp                  char(1) not null check (grp in ('A', 'B')),
  prior_status         varchar(30),
  opened_inspection_id uuid,
  settled_dt           timestamptz not null default clock_timestamp()
);

-- "Released" for a raw lot, in ONE place: the latest inspection's result, or LEGACY_RELEASE when a
-- legacy release is newer than every inspection (a re-test opened after it supersedes it). Null when
-- the lot has neither. Every floor and QC check reads this.
create or replace function inventory.rm_lot_qc_result(p_rm_batch_id uuid) returns text
language sql stable as $$
  select case
           when l.at is not null and (q.created_dt is null or l.at > q.created_dt) then 'LEGACY_RELEASE'
           when q.created_dt is not null then upper(coalesce(q.overall_result, ''))
         end
    from (select 1) one
    left join lateral (select overall_result, created_dt from quality.qc_inspections
                        where rm_batch_id = p_rm_batch_id order by created_dt desc nulls last limit 1) q on true
    left join lateral (select at from inventory.lot_qc_event
                        where rm_batch_id = p_rm_batch_id and event = 'LEGACY_RELEASE' order by at desc limit 1) l on true
$$;

-- The badge's facts: when, who (and their name when the id is a user on file), and the source row.
create or replace function inventory.rm_lot_legacy_release(p_rm_batch_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('label', 'Released before the sample rule',
           'releasedAt', to_char(l.released_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'releasedBy', l.released_by,
           'releasedByName', (select u.user_name from iam.user_master u where u.user_id::text = l.released_by),
           'source', l.source)
    from inventory.lot_qc_event l
   where l.rm_batch_id = p_rm_batch_id and l.event = 'LEGACY_RELEASE'
   order by l.at desc limit 1
$$;
