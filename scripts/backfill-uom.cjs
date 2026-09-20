/* WS8 — backfill unit-of-measure (uom_id) on quantity rows so every quantity in the UI reads with
 * its unit ("10 kg", "5 pcs", "10 ml") instead of a bare number. The tables all carry uom_id but it
 * shipped NULL; new records now capture it via the create forms, and this fills the existing rows.
 * Fully idempotent (updates only where uom_id is null; adds the PCS unit only if missing).
 * Strategy: materials default to KG; each material's unit propagates to its batches / GRN lines /
 * ingredients / PO+quotation lines / requirements; material-less tables get sensible defaults
 * (bulk oil → KG, finished goods / package orders / dispatch lines → PCS, QC samples → ML).
 * Run: DATABASE_URL=... node scripts/backfill-uom.cjs */
const postgres = require('postgres');

(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const log = (...a) => console.log('[backfill-uom]', ...a);
  const uomBy = async (code) => (await sql`select uom_id from platform.uom_master where uom_code = ${code} limit 1`)[0]?.uom_id ?? null;

  // 1. ensure a "Pieces" unit for counted goods (bottles / cartons / dispatch lines)
  let pcsId = await uomBy('PCS');
  if (!pcsId) {
    pcsId = (await sql`insert into platform.uom_master (uom_id, uom_code, uom_name, status, created_by, updated_by)
      values (gen_random_uuid(), 'PCS', 'Pieces', 'ACTIVE', 'seed', 'seed') returning uom_id`)[0].uom_id;
    log('added PCS (Pieces) unit');
  }
  const kg = await uomBy('KG-UI');
  const ml = await uomBy('Mililiter ML');

  // 2. materials default to KG (fragrance RM is compounded by weight) where no base unit is set
  if (kg) { const r = await sql`update masterdata.material set uom_id = ${kg}, updated_dt = now() where uom_id is null`; log('materials → KG:', r.count); }

  // 3. propagate each material's unit to its child quantity rows (only null + material-linked)
  for (const [s, t] of [
    ['inventory', 'rm_batch_master'], ['inventory', 'grn_items'], ['inventory', 'inventory_batch'],
    ['production', 'production_order_ingredients'], ['procurement', 'purchase_order_items'],
    ['procurement', 'quotation_items'], ['procurement', 'stock_requirement'],
  ]) {
    const r = await sql.unsafe(
      `update ${s}.${t} c set uom_id = m.uom_id, updated_dt = now()
         from masterdata.material m
        where c.material_id = m.material_id and c.uom_id is null and m.uom_id is not null`);
    log(`${s}.${t} ← material unit:`, r.count);
  }

  // 4. stock_transfer inherits the transferred inventory batch's unit
  { const r = await sql`update inventory.stock_transfer t set uom_id = b.uom_id, updated_dt = now()
       from inventory.inventory_batch b
      where t.inventory_batch_id = b.inventory_batch_id and t.uom_id is null and b.uom_id is not null`;
    log('stock_transfer ← batch unit:', r.count); }

  // 5. sensible defaults for the material-less quantity tables
  if (kg) { const r = await sql`update production.oil_batch_master set uom_id = ${kg}, updated_dt = now() where uom_id is null`; log('oil_batch_master → KG:', r.count); }
  const setDefault = async (s, t, uomId, name) => {
    const r = await sql.unsafe(`update ${s}.${t} set uom_id = $1, updated_dt = now() where uom_id is null`, [uomId]);
    log(`${s}.${t} → ${name}:`, r.count);
  };
  await setDefault('packaging', 'finished_good_batch_master', pcsId, 'PCS');
  await setDefault('packaging', 'package_order', pcsId, 'PCS');
  await setDefault('sales', 'dispatch_items', pcsId, 'PCS');
  if (ml) await setDefault('quality', 'qc_sample_retention', ml, 'ML');

  await sql.end();
  log('done.');
})().catch((e) => { console.error('[backfill-uom] FAILED:', e.message); process.exit(1); });
