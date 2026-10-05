-- Migration: 2026-10-05-formula-setup (lane vaultsetup; owner decisions 2026-10-05: products are
-- mostly blended in-house; "Ruh drafts, one person approves")
--
-- ADDITIVE + IDEMPOTENT ONLY (PB-16 convention): every statement is IF NOT EXISTS or a guarded DO
-- block, so a second run is a no-op. Two blocks, two databases:
--
--   @target: main     iam.user_master.account_kind — HUMAN (every person, the default for every
--                     existing row) or SERVICE (a non-login system principal: "Ruh (automation)",
--                     the Vault drafting account). AuthService refuses every sign-in for SERVICE;
--                     SecurityService lets a SERVICE account hold `formulator` only.
--
--   @target: formula  formula.formula_product_link — which factory product each Vault formula
--                     shell was drafted for, and the catalogue's classification of it
--                     (single_chemical / blend). packages/data-formula/src/schema/setup.ts.
--
-- No new permission rows here: `packaging:product_formula_link:read|write` come from
-- scripts/ra-permissions.ts / ra-roles.ts. On a fresh database the bootstrap seed adds them. On an
-- already-seeded database (production), apply the additive grant SQL from
-- scripts/gen-permission-grants.ts (docs/releases/rc-rp-1005-permission-grants.sql), never db:seed.
-- The formula schema already default-grants ra_vault (scripts/provision-vault-isolation.sql).

-- @target: main

alter table iam.user_master add column if not exists account_kind varchar(20) not null default 'HUMAN';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_master_account_kind_chk') then
    alter table iam.user_master add constraint user_master_account_kind_chk
      check (account_kind in ('HUMAN', 'SERVICE'));
  end if;
end $$;
-- A service principal never holds a password or an ALEMBIC identity binding.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_master_service_no_login_chk') then
    alter table iam.user_master add constraint user_master_service_no_login_chk
      check (account_kind <> 'SERVICE' or (password_hash is null and alembic_subject is null));
  end if;
end $$;

-- @target: formula

create table if not exists formula.formula_product_link (
  formula_product_link_id uuid primary key default uuidv7(),
  formula_id uuid not null references formula.formula_master (formula_id),
  product_id uuid not null,
  product_code varchar(50) not null,
  product_name varchar(200),
  kind varchar(20) not null,
  material_id uuid,
  status varchar(30),
  created_dt timestamptz not null default now(),
  updated_dt timestamptz not null default now(),
  created_by varchar(255),
  updated_by varchar(255)
);
create unique index if not exists formula_product_link_formula_uq on formula.formula_product_link (formula_id);
create unique index if not exists formula_product_link_product_uq on formula.formula_product_link (product_id);
create index if not exists formula_product_link_code_idx on formula.formula_product_link (product_code);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'formula_product_link_kind_chk') then
    alter table formula.formula_product_link add constraint formula_product_link_kind_chk check (
      (kind = 'single_chemical' and material_id is not null)
      or (kind = 'blend' and material_id is null)
    );
  end if;
end $$;
