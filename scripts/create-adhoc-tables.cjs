/* Reproducibility (audit H-R) — creates the objects the running app depends on that were added by
 * ad-hoc DDL and never made it into schema-as-code, so a FRESH (offline) console deploy boots
 * cleanly. DDL is faithful to the live tables (gen_random_uuid default, varchar(64) actor cols).
 * Idempotent (CREATE / ADD COLUMN IF NOT EXISTS). Included in `pnpm db:provision`.
 *   procurement.vendor_negotiation / po_advance_payment / vendor_dispatch
 *   iam.approval_matrix · sales.dispatch_document
 *   procurement.purchase_order.replacement_of_po_id  (selected by listPurchaseOrders → PO list 500s without it)
 * Run: DATABASE_URL=... node scripts/create-adhoc-tables.cjs */
const postgres = require('postgres');
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

  await sql.unsafe(`create table if not exists procurement.vendor_negotiation (
    vendor_negotiation_id uuid primary key default gen_random_uuid(),
    quotation_id uuid, vendor_id uuid, material_id uuid,
    original_rate numeric(18,4), revised_rate numeric(18,4),
    notes text, recommendation text,
    status varchar(30) default 'ACTIVE',
    created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
    created_by varchar(64), updated_by varchar(64)
  )`);

  await sql.unsafe(`create table if not exists procurement.po_advance_payment (
    po_advance_payment_id uuid primary key default gen_random_uuid(),
    purchase_order_id uuid, amount numeric(18,2), payment_date date, reference text,
    status varchar(30) default 'PAID',
    created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
    created_by varchar(64), updated_by varchar(64)
  )`);

  await sql.unsafe(`create table if not exists procurement.vendor_dispatch (
    vendor_dispatch_id uuid primary key default gen_random_uuid(),
    purchase_order_id uuid, dispatch_date date, transporter text, docket_number text, vehicle_number text,
    status varchar(30) default 'DISPATCHED',
    created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
    created_by varchar(64), updated_by varchar(64)
  )`);

  await sql.unsafe(`create table if not exists iam.approval_matrix (
    approval_matrix_id uuid primary key default gen_random_uuid(),
    ord integer, module text, transaction text,
    created_by text, submitted_to text, approved_by text, final_authority text, auto_approval text, remarks text,
    status varchar(20) default 'ACTIVE',
    created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
    created_by_user varchar(64), updated_by_user varchar(64)
  )`);

  await sql.unsafe(`create table if not exists sales.dispatch_document (
    dispatch_document_id uuid primary key default gen_random_uuid(),
    dispatch_id uuid, sales_order_id uuid, document_type text, document_number text, document_date date,
    amount numeric(18,2), reference text, received_by text, notes text,
    status varchar(30) default 'ISSUED',
    created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
    created_by varchar(64), updated_by varchar(64)
  )`);

  // Column the PO list depends on (replacement-PO / FAIL-branch tail).
  await sql.unsafe(`alter table procurement.purchase_order add column if not exists replacement_of_po_id uuid`);

  const chk = async (s, t) => (await sql`select count(*)::int c from information_schema.tables where table_schema=${s} and table_name=${t}`)[0].c;
  console.log('adhoc tables ready:',
    'vendor_negotiation', await chk('procurement', 'vendor_negotiation'),
    '· po_advance_payment', await chk('procurement', 'po_advance_payment'),
    '· vendor_dispatch', await chk('procurement', 'vendor_dispatch'),
    '· approval_matrix', await chk('iam', 'approval_matrix'),
    '· dispatch_document', await chk('sales', 'dispatch_document'));
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
