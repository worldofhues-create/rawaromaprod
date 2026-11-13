-- Rollback of 2026-11-26-vault-imports (IMPORT-RP, Vault). The history of formula uploads is lost;
-- every formula version an upload sealed stays (it was sealed through the Vault's own path).
-- @target: formula
drop table if exists formula.import_job_row;
drop table if exists formula.import_job;
delete from public.schema_migrations where id like '2026-11-26-vault-imports%';
