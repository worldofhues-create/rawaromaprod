/* Seeds the root organization (iam.org_master) that the main demo seed omits — without it,
 * business-unit creation has no organization to reference. Idempotent. Run:
 *   DATABASE_URL=... node scripts/seed-org.cjs */
const postgres = require('postgres');
const ACTOR = '019efe38-c5c3-74ef-a499-31e8bc10719b';
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const n = (await sql`select count(*)::int n from iam.org_master`)[0].n;
  if (n === 0) {
    const now = new Date();
    await sql`insert into iam.org_master ${sql({
      organization_id: require('crypto').randomUUID(), organization_code: 'RAW-AROMA', organization_name: 'RAW AROMACHEM',
      status: 'ACTIVE', created_dt: now, updated_dt: now, created_by: ACTOR, updated_by: ACTOR,
    })}`;
    console.log('seeded root org RAW AROMACHEM');
  } else {
    console.log('org_master already has', n, 'row(s) — nothing to do');
  }
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
