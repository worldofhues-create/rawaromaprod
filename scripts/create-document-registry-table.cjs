/* M01 Document Management — a real document registry with expiry tracking, versioning and entity
 * mapping (the base document_master is only a filename label). Binary bytes are out of Phase-1 scope
 * (no blob store on the $0 stack) — documents carry a source_url link + metadata. Idempotent.
 * Run: DATABASE_URL=... node scripts/create-document-registry-table.cjs */
const postgres = require('postgres');
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  await sql.unsafe(`create table if not exists platform.document_registry (
    document_registry_id uuid primary key,
    title            text,
    document_type    text,
    entity_type      text,           -- vendor | material | formula | customer | other
    entity_id        uuid,           -- soft ref to the mapped entity
    reference_no     text,
    source_url       text,           -- link to the file (no binary store on the free stack)
    file_name        text,
    version          integer not null default 1,
    supersedes_id    uuid,           -- prior version this one replaces
    issue_date       date,
    expiry_date      date,
    notes            text,
    status           text not null default 'ACTIVE',
    created_dt       timestamptz not null default now(),
    updated_dt       timestamptz not null default now(),
    created_by       varchar(64),
    updated_by       varchar(64))`);
  await sql.unsafe(`create index if not exists document_registry_entity_idx on platform.document_registry (entity_type, entity_id)`);
  await sql.unsafe(`create index if not exists document_registry_expiry_idx on platform.document_registry (expiry_date)`);
  console.log('platform.document_registry ready');
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
