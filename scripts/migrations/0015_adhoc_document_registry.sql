-- HAND-WRITTEN from scripts/create-document-registry-table.cjs (schema portion; that script
-- has no data-seed step, so it is reproduced here in full).
-- @target: main

create table if not exists platform.document_registry (
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
  updated_by       varchar(64)
);
create index if not exists document_registry_entity_idx on platform.document_registry (entity_type, entity_id);
create index if not exists document_registry_expiry_idx on platform.document_registry (expiry_date);
