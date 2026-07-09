/* Relay (offline air-gap) — creates the three store-and-forward tables in the platform schema.
 * Standalone CREATE because db:push skips the already-populated platform schema (mirrors
 * create-notification-log-table.cjs). Idempotent.
 *   relay_cursor  — per (direction, source_schema) export watermark (last_seq drained).
 *   relay_inbox   — event_id dedupe ledger on the import side (ON CONFLICT DO NOTHING).
 *   relay_package — hash-chained log of every package exported/imported per direction.
 * Run: DATABASE_URL=... node scripts/create-relay-tables.cjs */
const postgres = require('postgres');
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  await sql.unsafe(`create table if not exists platform.relay_cursor (
    direction text not null,
    source_schema text not null,
    last_seq bigint not null default 0,
    updated_dt timestamptz not null default now(),
    primary key (direction, source_schema)
  )`);
  await sql.unsafe(`create table if not exists platform.relay_inbox (
    event_id uuid primary key,
    package_id uuid,
    event_type text,
    direction text,
    imported_dt timestamptz not null default now()
  )`);
  await sql.unsafe(`create table if not exists platform.relay_package (
    package_id uuid not null,
    kind text not null,               -- EXPORT | IMPORT (same id can be both across the two consoles)
    direction text not null,
    package_hash text not null,
    prev_hash text,
    event_count integer not null default 0,
    created_dt timestamptz not null default now(),
    primary key (package_id, kind)
  )`);
  await sql.unsafe(`create index if not exists relay_package_dir_kind_idx on platform.relay_package(direction, kind, created_dt)`);
  await sql.unsafe(`create index if not exists relay_inbox_package_idx on platform.relay_inbox(package_id)`);
  const t = async (n) => (await sql.unsafe(`select count(*)::int c from platform.${n}`))[0].c;
  console.log('relay tables ready — cursor:', await t('relay_cursor'), 'inbox:', await t('relay_inbox'), 'package:', await t('relay_package'));
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
