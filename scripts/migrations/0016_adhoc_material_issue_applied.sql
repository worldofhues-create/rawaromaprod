-- HAND-WRITTEN from scripts/create-material-issue-applied-table.cjs (full script — the backfill
-- INSERT is included because it is the correctness-critical part (H-C3): it marks every
-- PRE-EXISTING production.material_issue row as already-applied so enabling the consumption
-- subscriber never retroactively decrements historical on-hand. On an empty database
-- production.material_issue has no rows, so this is a genuine no-op there; on the old-state
-- fixture used for PB-16's second reconciliation path it is exactly the behaviour being proven.
-- Runs after 0008_production.sql (production.material_issue).
-- @target: main

create table if not exists inventory.material_issue_applied (
  material_issue_id uuid primary key,
  item_count integer,
  applied_dt timestamptz not null default now()
);

insert into inventory.material_issue_applied (material_issue_id, item_count)
  select material_issue_id, 0 from production.material_issue
  on conflict (material_issue_id) do nothing;
