-- HAND-WRITTEN from scripts/create-vault-audit-guard.cjs (full script — a trigger, not data).
-- Targets the vault's OWN connection (formula falls back to DATABASE_URL when
-- FORMULA_DATABASE_URL is unset, same as every other @target: formula block).
-- @target: formula

create or replace function formula.audit_events_append_only()
  returns trigger language plpgsql as $$
  begin
    raise exception 'formula.audit_events is append-only — % is blocked (tamper-evident access log)', tg_op;
  end $$;

drop trigger if exists audit_events_append_only on formula.audit_events;

create trigger audit_events_append_only
  before update or delete on formula.audit_events
  for each row execute function formula.audit_events_append_only();
