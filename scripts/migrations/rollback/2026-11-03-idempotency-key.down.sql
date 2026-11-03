-- Rollback for 2026-11-03-idempotency-key (SWEEP2-R1). Drops the store and its migration record, so
-- `pnpm db:migrate` re-applies it. Losing the table only loses replay protection for keys already
-- issued; no business row lives here.

-- @target: main

drop table if exists platform.idempotency_key;
delete from public.schema_migrations where id like '2026-11-03-idempotency-key%';
