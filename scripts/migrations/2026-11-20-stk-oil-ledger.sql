-- Migration: 2026-11-20-stk-oil-ledger (STOCK-FIX-RP, STK-10 and STK-11; LD-19 "stock is one equation").
--
-- The rehearsal (docs/plan/stock-e2e-rehearsal.md section 3) found the finished side of the stock
-- equation recorded nowhere: the oil a batch made was a number on oil_batch_master that packing never
-- drew down, so 700,000 mg was packed from 499,676 mg; a failed batch's oil was never written off; no
-- loss, yield or remnant had a column anywhere. Now the oil is a stock that moves, in integer mg:
--
--   production.oil_batch_movement   append-only ledger of one oil batch's mass:
--        MADE           +  the sum of the weighed lines (one per batch)
--        PACKED         -  packs filled x the pack's net content (one per filling record)
--        PACK_REJECTED  -  packs filled and rejected x net content (the oil is in a reject)
--        LOSS           -  book remaining less what the scale reads at a remnant count (reason)
--        WRITE_OFF      -  a remnant, or a failed batch, written off (reason, named role)
--     remaining = the sum of delta_mg. Nothing updates or deletes a row (trigger below).
--   production.oil_batch_remnant    each remnant decision: what the scale read, what the book held,
--     the loss, and KEEP (packable later), HOLD (no packing until decided) or WRITE_OFF. Append-only;
--     the latest row is the remnant's state.
--   packaging.product_sku.net_content_mg   the pack's net content, so a fill can draw the oil down.
--     Null keeps today's free-text pack_size, read when it is a plain mass ("100 g"); a size in ml or
--     anything else is never converted (no density on file) and the fill is refused until it is set.
--
-- BACKFILL (idempotent): every existing oil batch whose produced_qty is in g, kg or mg gets its MADE
-- row, and every existing filling record whose SKU's size reads as a mass gets its PACKED and
-- PACK_REJECTED rows, so a batch already packed does not suddenly read as full. A batch or fill that
-- cannot be converted is left without rows and reports "not measured", never a guess.
-- Rollback: scripts/migrations/rollback/2026-11-20-stk-oil-ledger.down.sql

-- @target: main

alter table packaging.product_sku add column if not exists net_content_mg bigint;
alter table packaging.product_sku drop constraint if exists product_sku_net_content_mg_chk;
alter table packaging.product_sku add constraint product_sku_net_content_mg_chk check (net_content_mg is null or net_content_mg > 0);

create table if not exists production.oil_batch_movement (
  oil_batch_movement_id    uuid primary key,
  oil_batch_id             uuid not null,
  kind                     varchar(20) not null check (kind in ('MADE', 'PACKED', 'PACK_REJECTED', 'LOSS', 'WRITE_OFF')),
  delta_mg                 bigint not null,
  package_order_id         uuid,
  ref_id                   uuid,
  reason                   text,
  recorded_by              varchar(255) not null,
  recorded_role            varchar(200),
  recorded_dt              timestamptz not null default clock_timestamp(),
  constraint oil_batch_movement_sign_chk check ((kind = 'MADE' and delta_mg >= 0) or (kind <> 'MADE' and delta_mg <= 0)),
  constraint oil_batch_movement_reason_chk check (kind not in ('LOSS', 'WRITE_OFF') or (reason is not null and btrim(reason) <> ''))
);
create unique index if not exists oil_batch_movement_made_uq on production.oil_batch_movement (oil_batch_id) where kind = 'MADE';
create unique index if not exists oil_batch_movement_ref_uq on production.oil_batch_movement (kind, ref_id) where ref_id is not null;
create index if not exists oil_batch_movement_batch_idx on production.oil_batch_movement (oil_batch_id);
create index if not exists oil_batch_movement_order_idx on production.oil_batch_movement (package_order_id) where package_order_id is not null;

create table if not exists production.oil_batch_remnant (
  oil_batch_remnant_id     uuid primary key,
  oil_batch_id             uuid not null,
  weighed_mg               bigint not null check (weighed_mg >= 0),
  book_mg                  bigint not null check (book_mg >= 0),
  loss_mg                  bigint not null check (loss_mg >= 0),
  disposition              varchar(12) not null check (disposition in ('KEEP', 'HOLD', 'WRITE_OFF')),
  reason                   text,
  decided_by               varchar(255) not null,
  decided_role             varchar(200),
  decided_dt               timestamptz not null default clock_timestamp(),
  constraint oil_batch_remnant_sum_chk check (book_mg = weighed_mg + loss_mg),
  constraint oil_batch_remnant_reason_chk check ((loss_mg = 0 and disposition <> 'WRITE_OFF') or (reason is not null and btrim(reason) <> ''))
);
create index if not exists oil_batch_remnant_batch_idx on production.oil_batch_remnant (oil_batch_id, decided_dt desc);

create or replace function production.stk_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: a stock movement is corrected by a new row, never rewritten', tg_table_name;
end $$;
drop trigger if exists oil_batch_movement_append_only on production.oil_batch_movement;
create trigger oil_batch_movement_append_only before update or delete on production.oil_batch_movement
  for each row execute function production.stk_append_only();
drop trigger if exists oil_batch_remnant_append_only on production.oil_batch_remnant;
create trigger oil_batch_remnant_append_only before update or delete on production.oil_batch_remnant
  for each row execute function production.stk_append_only();

-- Backfill MADE from produced_qty in a mass unit (exact: numeric x factor is whole for 4 places of g).
insert into production.oil_batch_movement (oil_batch_movement_id, oil_batch_id, kind, delta_mg, recorded_by, recorded_role, recorded_dt)
select gen_random_uuid(), ob.oil_batch_id, 'MADE',
       (ob.produced_qty * case lower(u.uom_code) when 'kg' then 1000000 when 'g' then 1000 when 'gm' then 1000 when 'mg' then 1 end)::bigint,
       'migration:2026-11-20-stk-oil-ledger', 'system', coalesce(ob.produced_dt, ob.created_dt)
  from production.oil_batch_master ob
  join platform.uom_master u on u.uom_id = ob.uom_id
 where ob.produced_qty is not null and lower(u.uom_code) in ('kg', 'g', 'gm', 'mg')
   and (ob.produced_qty * case lower(u.uom_code) when 'kg' then 1000000 when 'g' then 1000 when 'gm' then 1000 when 'mg' then 1 end)
       = trunc(ob.produced_qty * case lower(u.uom_code) when 'kg' then 1000000 when 'g' then 1000 when 'gm' then 1000 when 'mg' then 1 end)
   and not exists (select 1 from production.oil_batch_movement m where m.oil_batch_id = ob.oil_batch_id and m.kind = 'MADE');

-- Backfill PACKED / PACK_REJECTED for fills recorded before this, where the SKU's size is a plain mass.
with sz as (
  select s.product_sku_id,
         (substring(s.pack_size from '^\s*([0-9]+(?:\.[0-9]+)?)\s*(?:mg|g|gm|gms|gram|grams|kg|kgs)\s*$')::numeric
           * case lower(substring(s.pack_size from '([a-zA-Z]+)\s*$'))
               when 'kg' then 1000000 when 'kgs' then 1000000 when 'mg' then 1 else 1000 end) as net_mg
    from packaging.product_sku s
   where s.pack_size ~* '^\s*[0-9]+(\.[0-9]+)?\s*(mg|g|gm|gms|gram|grams|kg|kgs)\s*$'),
fills as (
  select d.filling_session_detail_id, po.oil_batch_id, po.package_order_id, coalesce(d.filled_qty, 0) as filled, coalesce(d.rejected_qty, 0) as rejected,
         coalesce(s.net_content_mg, sz.net_mg) as net_mg, coalesce(d.recorded_dt, d.created_dt) as at
    from packaging.filling_session_details d
    join packaging.filling_session fs on fs.filling_session_id = d.filling_session_id
    join packaging.package_order po on po.package_order_id = fs.package_order_id
    left join packaging.product_sku s on s.product_sku_id = po.product_sku_id
    left join sz on sz.product_sku_id = po.product_sku_id
   where po.oil_batch_id is not null
     and exists (select 1 from production.oil_batch_movement m where m.oil_batch_id = po.oil_batch_id and m.kind = 'MADE'))
insert into production.oil_batch_movement (oil_batch_movement_id, oil_batch_id, kind, delta_mg, package_order_id, ref_id, recorded_by, recorded_role, recorded_dt)
select gen_random_uuid(), f.oil_batch_id, k.kind, -(k.qty * f.net_mg)::bigint, f.package_order_id, f.filling_session_detail_id,
       'migration:2026-11-20-stk-oil-ledger', 'system', f.at
  from fills f
  cross join lateral (values ('PACKED', f.filled), ('PACK_REJECTED', f.rejected)) as k(kind, qty)
 where f.net_mg is not null and k.qty > 0 and k.qty = trunc(k.qty)
   and not exists (select 1 from production.oil_batch_movement m where m.kind = k.kind and m.ref_id = f.filling_session_detail_id);

-- The app role reads and appends; the trigger refuses UPDATE and DELETE for everyone.
do $$
declare
  app text := nullif(current_setting('rawprod.app_role', true), '');
begin
  if app is null then
    raise notice 'stk-oil-ledger grants: DB_APP_ROLE is not set, so no application role was granted';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app) then
    raise exception 'stk-oil-ledger grants: DB_APP_ROLE "%" is not a role in this cluster', app;
  end if;
  execute format('grant select, insert on production.oil_batch_movement, production.oil_batch_remnant to %I', app);
end $$;
