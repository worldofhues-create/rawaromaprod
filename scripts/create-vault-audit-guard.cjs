/* #6 vault hardening — DB-level append-only enforcement on the formula access audit.
 * data-kernel/audit.ts says the hash-chained log must be append-only "with a table grant
 * (REVOKE UPDATE, DELETE) ... not here" — it was never provisioned. A BEFORE UPDATE/DELETE trigger
 * is stronger (independent of role grants): even a DB-write attacker cannot rewrite or delete a
 * row of the tamper-evident access log. INSERT (the vault's own append) is unaffected. Idempotent.
 * Runs against the formula DB (FORMULA_DATABASE_URL if set, else DATABASE_URL).
 * Run: DATABASE_URL=... [FORMULA_DATABASE_URL=...] node scripts/create-vault-audit-guard.cjs */
const postgres = require('postgres');
(async () => {
  const url = process.env.FORMULA_DATABASE_URL || process.env.DATABASE_URL;
  const sql = postgres(url, { max: 1, prepare: false });
  await sql.unsafe(`create or replace function formula.audit_events_append_only()
    returns trigger language plpgsql as $$
    begin
      raise exception 'formula.audit_events is append-only — % is blocked (tamper-evident access log)', tg_op;
    end $$`);
  await sql.unsafe(`drop trigger if exists audit_events_append_only on formula.audit_events`);
  await sql.unsafe(`create trigger audit_events_append_only
    before update or delete on formula.audit_events
    for each row execute function formula.audit_events_append_only()`);
  console.log('formula.audit_events append-only trigger installed.');
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
