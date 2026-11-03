-- Rollback for 2026-11-03-vault-idempotency-key (SWEEP2-R1, Vault). Drops the store and its ledger
-- row so `pnpm db:migrate` re-applies it. Only replay protection is lost; no formula row lives here.

-- @target: formula

drop table if exists formula.idempotency_key;
delete from public.schema_migrations where id like '2026-11-03-vault-idempotency-key%';
