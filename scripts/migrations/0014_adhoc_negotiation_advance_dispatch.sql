-- HAND-WRITTEN from scripts/create-adhoc-tables.cjs (schema portion only — that script's own
-- reproducibility comment already calls this DDL "faithful to the live tables"). Runs after
-- 0001-0013.
--
-- TWO of that script's six statements are DELIBERATELY DROPPED here, not overlooked:
--   iam.approval_matrix                          — now IN packages/data-org's Drizzle schema
--     (see 0001_iam.sql), with a DIFFERENT, current column set (organization_id/policy_type
--     FK'd, not this script's free-text created_by/submitted_to/...). db:push already creates
--     the current shape; re-creating the old shape here would only matter if 0001 ran second,
--     which it never does (0001 < 0014).
--   procurement.purchase_order.replacement_of_po_id — now a real column in
--     packages/data-procurement's Drizzle schema (see 0005_procurement.sql, inline in the
--     CREATE TABLE, plus its FK and index). The ADD COLUMN IF NOT EXISTS here would be a
--     permanent no-op.
-- Keeping either would not be WRONG (both are idempotent CREATE/ADD IF NOT EXISTS), but this
-- migration set's whole point is "the schema you get by reading it", and a statement that can
-- never fire is exactly the kind of drift PB-16 exists to remove.
-- @target: main

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
