-- Migration: 2026-10-27-sales-request (SALES-REQUEST-BRIDGE; docs/bridge/EVENT_CONTRACT.md,
-- "Sales requests"). ALEMBIC may now send a production requirement with NO order behind it:
-- `origin: "sales_request"` and `request_ref` in place of `order_ref` on the existing
-- ProductionRequirementCreated / Changed / Cancelled.
--
-- ADDITIVE + IDEMPOTENT (PB-16 convention). Every existing row is an order requirement and gets
-- origin 'order' from the default; nothing about it changes. Main database only.

-- @target: main

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
