/* Fills the three 24-step flow stages the main seed left empty, so the corrected chain-of-custody
 * graph shows real data at every stage: Stock Planning, Production QC, Dispatch.
 * Idempotent: clears these tables then re-inserts, referencing existing materials / oil batches /
 * sales orders / FG batches. Run: DATABASE_URL=... node scripts/seed-flow-gaps.cjs */
const postgres = require('postgres');
const ACTOR = '019efe38-c5c3-74ef-a499-31e8bc10719b'; // owner
const id = () => require('crypto').randomUUID();
const now = () => new Date();
const ago = (d) => new Date(Date.now() - d * 86400000);

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const sql = postgres(url, { max: 1, prepare: false });
  const meta = { status: 'ACTIVE', created_dt: now(), updated_dt: now(), created_by: ACTOR, updated_by: ACTOR };

  // refs
  const mats = (await sql`select material_id from masterdata.material order by material_code limit 5`).map((r) => r.material_id);
  const loc = (await sql`select location_id from location.location_master limit 1`)[0].location_id;
  const oils = await sql`select oil_batch_id from production.oil_batch_master order by batch_number`;
  const sos = await sql`select sales_order_id, customer_id from sales.sales_order order by so_number`;
  const tr = (await sql`select transporter_id from sales.transporter_master limit 1`)[0]?.transporter_id ?? null;
  const fg = await sql`select finished_good_batch_id from packaging.finished_good_batch_master order by batch_number`;

  // clear (children first)
  await sql`delete from sales.dispatch_items`;
  await sql`delete from sales.dispatch_master`;
  await sql`delete from production.production_qc`;
  await sql`delete from procurement.stock_req_items`;
  await sql`delete from procurement.stock_requirement`;

  // 1 — Stock Planning: a reorder requirement per material below par
  const prio = ['HIGH', 'MEDIUM', 'HIGH', 'LOW', 'MEDIUM'];
  for (let i = 0; i < mats.length; i++) {
    await sql`insert into procurement.stock_requirement ${sql({
      stock_requirement_id: id(), location_id: loc, material_id: mats[i],
      required_qty: String((i + 2) * 10), uom_id: null, required_by_date: ago(-7 - i),
      requirement_source: 'REORDER', priority: prio[i], ...meta,
    })}`;
  }

  // 18 — Production QC: one record per oil batch (mostly pass)
  for (let i = 0; i < oils.length; i++) {
    await sql`insert into production.production_qc ${sql({
      production_qc_id: id(), oil_batch_id: oils[i].oil_batch_id, qc_parameter_id: null,
      observed_value: String((0.992 + i * 0.003).toFixed(3)),
      result: i === 2 ? 'HOLD' : 'PASS', inspected_by: ACTOR, inspection_dt: ago(2 - i), ...meta,
    })}`;
  }

  // 23 — Dispatch: dispatch the first 3 confirmed sales orders, linked to an FG batch
  for (let i = 0; i < Math.min(3, sos.length); i++) {
    const did = id();
    await sql`insert into sales.dispatch_master ${sql({
      dispatch_id: did, sales_order_id: sos[i].sales_order_id, customer_id: sos[i].customer_id,
      dispatch_date: ago(1 - i), vehicle_number: 'TN-22-' + (4500 + i), transporter_id: tr,
      status: i === 0 ? 'DELIVERED' : 'DISPATCHED', created_dt: now(), updated_dt: now(), created_by: ACTOR, updated_by: ACTOR,
    })}`;
    if (fg[i]) await sql`insert into sales.dispatch_items ${sql({
      dispatch_item_id: id(), dispatch_id: did, sales_order_item_id: null,
      finished_good_batch_id: fg[i].finished_good_batch_id, dispatched_qty: String((i + 1) * 500), uom_id: null, ...meta,
    })}`;
  }

  const c = async (s, t) => (await sql.unsafe('select count(*)::int n from ' + s + '.' + t))[0].n;
  console.log('flow-gaps seeded — stock_requirement', await c('procurement', 'stock_requirement'),
    '| production_qc', await c('production', 'production_qc'),
    '| dispatch', await c('sales', 'dispatch_master'), '| dispatch_items', await c('sales', 'dispatch_items'));
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
