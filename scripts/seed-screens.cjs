/* Seeds a few rows for the flow stages that had data tables but no seeded rows, so the new
 * RFQ / Quotation / Material pick-list / Material issue screens show real data.
 * Idempotent: clears these tables then re-inserts referencing existing PRs / vendors / orders.
 * Run: DATABASE_URL=... node scripts/seed-screens.cjs */
const postgres = require('postgres');
const ACTOR = '019efe38-c5c3-74ef-a499-31e8bc10719b';
const id = () => require('crypto').randomUUID();
const now = () => new Date();
const ago = (d) => new Date(Date.now() - d * 86400000);
const dstr = (d) => ago(d).toISOString().slice(0, 10);

(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const meta = (status) => ({ status: status, created_dt: now(), updated_dt: now(), created_by: ACTOR, updated_by: ACTOR });
  const prs = await sql`select purchase_request_id from procurement.purchase_request order by created_dt limit 2`;
  const vends = await sql`select vendor_id from procurement.vendor_details order by vendor_code limit 3`;
  const orders = await sql`select production_order_id from production.production_order order by created_dt limit 2`;

  await sql`delete from production.material_issue_item`;
  await sql`delete from production.material_issue`;
  await sql`delete from production.material_pick_list_items`;
  await sql`delete from production.material_pick_list`;
  await sql`delete from procurement.quotation_items`;
  await sql`delete from procurement.quotations`;
  await sql`delete from procurement.rfq_items`;
  await sql`delete from procurement.rfq_master`;

  const rfqIds = [];
  for (let i = 0; i < 2; i++) {
    const rid = id(); rfqIds.push(rid);
    await sql`insert into procurement.rfq_master ${sql({ rfq_id: rid, rfq_number: 'RFQ-2406-' + (10 + i), purchase_request_id: prs[i] ? prs[i].purchase_request_id : null, rfq_date: dstr(9 - i), submission_deadline: dstr(-3 + i), ...meta('OPEN') })}`;
  }
  for (let i = 0; i < 3; i++) {
    await sql`insert into procurement.quotations ${sql({ quotation_id: id(), rfq_id: rfqIds[i % 2], vendor_id: vends[i] ? vends[i].vendor_id : null, quotation_number: 'QT-2406-' + (20 + i), quotation_date: dstr(6 - i), valid_until_date: dstr(-20), ...meta('RECEIVED') })}`;
  }
  const plIds = [];
  for (let i = 0; i < 2; i++) {
    const pid = id(); plIds.push(pid);
    await sql`insert into production.material_pick_list ${sql({ material_pick_list_id: pid, production_order_id: orders[i] ? orders[i].production_order_id : null, pick_list_date: dstr(4 - i), generated_by: ACTOR, ...meta('GENERATED') })}`;
  }
  for (let i = 0; i < 2; i++) {
    await sql`insert into production.material_issue ${sql({ material_issue_id: id(), production_order_id: orders[i] ? orders[i].production_order_id : null, material_pick_list_id: plIds[i], issued_dt: ago(3 - i), issued_by: ACTOR, ...meta('ISSUED') })}`;
  }

  const c = async (s, t) => (await sql.unsafe('select count(*)::int n from ' + s + '.' + t))[0].n;
  console.log('screens seeded — rfq', await c('procurement', 'rfq_master'), '| quotations', await c('procurement', 'quotations'),
    '| pick_lists', await c('production', 'material_pick_list'), '| issues', await c('production', 'material_issue'));
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
