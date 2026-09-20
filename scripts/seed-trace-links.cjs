/* Wires the FK hops the main seed left unlinked, so reverse traceability (FG → oil → run →
 * materials → RM batch → GRN → vendor) walks end to end:
 *   - packaging.package_order.oil_batch_id  (matched to the run that made the product's formula)
 *   - inventory.rm_batch_master.grn_item_id (matched to a GRN item of the same material)
 * Idempotent. Run: DATABASE_URL=... node scripts/seed-trace-links.cjs */
const postgres = require('postgres');
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  await sql.unsafe(`update packaging.package_order po set oil_batch_id = sub.oil_batch_id, updated_dt = now()
    from (
      select distinct on (pm.formula_id) pm.formula_id, ob.oil_batch_id
      from production.oil_batch_master ob
      join production.production_order pro on pro.production_order_id = ob.production_order_id
      join formula.formula_version fv on fv.formula_version_id = pro.formula_version_id
      join formula.formula_master fm on fm.formula_id = fv.formula_id
      join packaging.product_master pm on pm.formula_id = fm.formula_id
      order by pm.formula_id, ob.batch_number
    ) sub
    join packaging.product_sku ps on ps.product_id = (select product_id from packaging.product_master where formula_id = sub.formula_id limit 1)
    where po.product_sku_id = ps.product_sku_id`);
  await sql.unsafe(`update packaging.package_order set oil_batch_id = (select oil_batch_id from production.oil_batch_master order by batch_number limit 1) where oil_batch_id is null`);
  await sql.unsafe(`update inventory.rm_batch_master rb set grn_item_id = (select gi.grn_item_id from inventory.grn_items gi where gi.material_id = rb.material_id limit 1), updated_dt = now() where rb.grn_item_id is null`);
  const po = (await sql`select count(oil_batch_id)::int n from packaging.package_order`)[0].n;
  const rb = (await sql`select count(grn_item_id)::int n from inventory.rm_batch_master`)[0].n;
  console.log('trace links — package_orders w/ oil:', po, '| rm_batches w/ grn:', rb);
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
