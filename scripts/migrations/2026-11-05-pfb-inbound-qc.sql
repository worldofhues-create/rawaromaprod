-- Migration: 2026-11-05-pfb-inbound-qc (PROD-B, production floor plan phase P2, sections 4, 7, 12.1,
-- 12.7, 12.8). Receiving checked a delivery only as received-versus-ordered per GRN line: no checklist,
-- no shortfall rule, nothing held at the gate without a PO, and an advance was written as PAID the moment
-- it was recorded. QC had one fixed spec row per product, so a spec change rewrote what an old batch had
-- been tested against, and nothing stopped a batch being reworked forever.
--
--   inventory.gate_entry_master.hold_reason   why a delivery is held at the gate (no PO, closed PO, wrong vendor)
--   inventory.receiving_audit(+_line)         the kiosk checklist per PO line and the 12.1 decision it produced,
--                                             with the policy rule and version that decided it
--   procurement.debit_note                    raised automatically for rejected and short quantities
--   procurement.po_payment_release            12.8: requested -> approved -> released with a UTR, maker-checker
--   quality.qc_checkpoint_set / qc_checkpoint versioned checkpoint lists per product; an old batch keeps its set
--   quality.batch_qc_round / batch_rework     every QC round on a batch and every rework, with the decision
--   inventory.lot_hold                        a frozen raw lot or batch, until released with a reason
--   inventory.raw_lot_label                   the raw-lot label printed at putaway (REPRINT after the first)
--
-- Quantities are integer base units (mg for mass, units for counted goods); money is integer paise.
-- ADDITIVE + IDEMPOTENT (PB-16 convention). Main only.
-- Rollback: scripts/migrations/rollback/2026-11-05-pfb-inbound-qc.down.sql

-- @target: main

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
