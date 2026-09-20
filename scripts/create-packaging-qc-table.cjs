/* Module 9 — Packaging QC. Creates the packaging.packaging_qc table (a late-added stage the main
 * schema omitted) and seeds a few rows. Idempotent. Run: DATABASE_URL=... node scripts/create-packaging-qc-table.cjs */
const postgres = require('postgres');
const ACTOR = '019efe38-c5c3-74ef-a499-31e8bc10719b';
const id = () => require('crypto').randomUUID();
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  await sql.unsafe(`create table if not exists packaging.packaging_qc (
    packaging_qc_id uuid primary key, finished_good_batch_id uuid, package_order_id uuid,
    leakage_check text, label_check text, carton_check text, overall_result text,
    inspected_by uuid, inspection_dt timestamptz, status text,
    created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
    created_by uuid, updated_by uuid)`);
  if ((await sql`select count(*)::int n from packaging.packaging_qc`)[0].n === 0) {
    const fgs = await sql`select finished_good_batch_id from packaging.finished_good_batch_master order by batch_number limit 3`;
    const checks = [['PASS', 'PASS', 'PASS', 'PASS'], ['PASS', 'PASS', 'PASS', 'PASS'], ['FAIL', 'PASS', 'PASS', 'FAIL']];
    for (let i = 0; i < fgs.length; i++) {
      const c = checks[i];
      await sql`insert into packaging.packaging_qc ${sql({
        packaging_qc_id: id(), finished_good_batch_id: fgs[i].finished_good_batch_id,
        leakage_check: c[0], label_check: c[1], carton_check: c[2], overall_result: c[3],
        inspected_by: ACTOR, inspection_dt: new Date(Date.now() - i * 86400000), status: 'ACTIVE',
        created_by: ACTOR, updated_by: ACTOR,
      })}`;
    }
  }
  console.log('packaging_qc ready, rows:', (await sql`select count(*)::int n from packaging.packaging_qc`)[0].n);
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
