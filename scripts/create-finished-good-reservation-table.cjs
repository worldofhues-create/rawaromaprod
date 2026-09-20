/* FG stock — creates packaging.finished_good_reservation (the finished-good analogue of
 * inventory.stock_reservation, which is RM-only). Ships as a standalone CREATE because db:push
 * skips the already-populated `packaging` schema. Idempotent. DDL matches the drizzle dictPk +
 * metaColumns contract exactly (uuid pk default uuidv7(); status varchar(30); *_dt timestamptz
 * default now(); created_by/updated_by varchar(255)).
 * Run: DATABASE_URL=... node scripts/create-finished-good-reservation-table.cjs */
const postgres = require('postgres');
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  // uuidv7() already exists (installed by db:push prereqs; every packaging dict table defaults to
  // it) — reuse it, never redefine, so we don't clobber the canonical definition.
  await sql.unsafe(`create table if not exists packaging.finished_good_reservation (
    finished_good_reservation_id uuid primary key default uuidv7(),
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
  )`);
  await sql.unsafe(`create index if not exists finished_good_reservation_batch_idx on packaging.finished_good_reservation(finished_good_batch_id)`);
  await sql.unsafe(`create index if not exists finished_good_reservation_sku_idx on packaging.finished_good_reservation(product_sku_id)`);
  await sql.unsafe(`create index if not exists finished_good_reservation_document_idx on packaging.finished_good_reservation(reserved_for_document_id)`);
  const n = (await sql`select count(*)::int n from packaging.finished_good_reservation`)[0].n;
  console.log('finished_good_reservation ready, rows:', n);
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
