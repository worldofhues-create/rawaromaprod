-- Migration: 2026-11-19-prom-9-requirement-hold (PROM-9, LD-85). The storefront prints "If a raw material
-- changes, we tell you before your next order". For a made-to-order line that means: if the product's
-- continuity key moves between the order and the batch, ALEMBIC tells the customer and HOLDS the
-- requirement until they confirm, and the factory must not plan it meanwhile. ALEMBIC says so on the
-- existing ProductionRequirementChanged event, as `hold: { reason_code, since } | null`
-- (ALEMBIC packages/domain/src/bridge/outbound-payload.ts requirementHoldPayload).
--
--   bridge.production_requirement.customer_hold_reason   why ALEMBIC holds it (closed list), or null
--   bridge.production_requirement.customer_hold_since    since when, as ALEMBIC sent it, or null
--
-- Both set or both null. Nothing about the customer or the notice is stored here.
-- ADDITIVE + IDEMPOTENT. No existing row changes (every requirement reads "not held").
-- Rollback: scripts/migrations/rollback/2026-11-19-prom-9-requirement-hold.down.sql

-- @target: main

alter table bridge.production_requirement add column if not exists customer_hold_reason varchar(40);
alter table bridge.production_requirement add column if not exists customer_hold_since timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'production_requirement_customer_hold_chk') then
    alter table bridge.production_requirement add constraint production_requirement_customer_hold_chk
      check ((customer_hold_reason is null) = (customer_hold_since is null)
             and (customer_hold_reason is null or customer_hold_reason in ('material_change_unacknowledged')));
  end if;
end $$;
