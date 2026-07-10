/* H-C3 — dedupe ledger for the production→inventory consumption subscriber. One row per
 * material_issue that has had its RM on-hand decremented, so the subscriber applies each issue
 * EXACTLY once (idempotent). Standalone CREATE (db:push skips the populated inventory schema).
 *
 * CRITICAL: backfills every EXISTING material_issue as already-applied, so enabling the subscriber
 * does NOT retroactively decrement historical on-hand — it consumes only issues created from now on.
 * Idempotent. Run: DATABASE_URL=... node scripts/create-material-issue-applied-table.cjs */
const postgres = require('postgres');
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  await sql.unsafe(`create table if not exists inventory.material_issue_applied (
    material_issue_id uuid primary key,
    item_count integer,
    applied_dt timestamptz not null default now()
  )`);
  // Mark all existing issues as applied (item_count 0) so history is never retroactively decremented.
  const res = await sql.unsafe(`insert into inventory.material_issue_applied (material_issue_id, item_count)
    select material_issue_id, 0 from production.material_issue
    on conflict (material_issue_id) do nothing`);
  const n = (await sql`select count(*)::int c from inventory.material_issue_applied`)[0].c;
  console.log(`material_issue_applied ready — backfilled existing issues, total rows: ${n}`);
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
