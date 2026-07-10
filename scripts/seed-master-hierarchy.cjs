/* Portal-audit WS6 — seed the empty org + location master hierarchy so the Admin and Warehouse
 * portals stop rendering blank and the org→business-unit→location and warehouse→floor→zone→
 * rack→shelf→bin chains are coherent end-to-end. Fully idempotent (ensure-by-code / update-only-
 * when-null), and guarded so it is safe on a fresh deploy where the parent rows may not exist yet
 * (it runs AFTER the base org/location/user seeds in `pnpm db:provision`).
 *
 * Seeds: platform.country_master, location.location_type_master, iam.business_unit_master,
 *        location.floor_master (one per warehouse), location.bin_master (per shelf).
 * Wires: location_master.{organization_id,business_unit_id,location_type_id}, org.registration_
 *        country_id, zone_master.floor_id — only where currently null.
 * Backfills: iam.user_master.{employee_code,mobile_number} where null.
 * Run: DATABASE_URL=... node scripts/seed-master-hierarchy.cjs */
const postgres = require('postgres');

const COUNTRIES = [
  ['IN', 'India'], ['US', 'United States'], ['GB', 'United Kingdom'],
  ['AE', 'United Arab Emirates'], ['FR', 'France'], ['SG', 'Singapore'],
];
const LOCATION_TYPES = [
  ['FACTORY', 'Factory'], ['WAREHOUSE', 'Warehouse'],
  ['LAB', 'Laboratory'], ['OFFICE', 'Office'],
];
const BUSINESS_UNITS = [
  ['BU-MFG', 'Manufacturing'], ['BU-QC', 'Quality & Compliance'], ['BU-SCM', 'Supply Chain'],
];

(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const log = (...a) => console.log('[seed-master-hierarchy]', ...a);

  // ── ensure helper: return existing id by a WHERE match, else insert and return the new id ──
  async function ensure(table, pkCol, whereObj, values) {
    const wKeys = Object.keys(whereObj);
    const wSql = wKeys.map((k, i) => `${k} = $${i + 1}`).join(' and ');
    const found = await sql.unsafe(
      `select ${pkCol} as id from ${table} where ${wSql} limit 1`,
      wKeys.map((k) => whereObj[k]),
    );
    if (found.length) return found[0].id;
    const cols = Object.keys(values);
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await sql.unsafe(
      `insert into ${table} (${pkCol}, ${cols.join(', ')}, status, created_by, updated_by)
       values (gen_random_uuid(), ${ph}, 'ACTIVE', 'seed', 'seed') returning ${pkCol} as id`,
      cols.map((c) => values[c]),
    );
    return r[0].id;
  }

  // ── countries ──
  let indiaId = null;
  for (const [code, name] of COUNTRIES) {
    const id = await ensure('platform.country_master', 'country_id', { country_code: code },
      { country_code: code, country_name: name });
    if (code === 'IN') indiaId = id;
  }
  log('countries ok (India =', indiaId, ')');

  // ── location types ──
  let warehouseTypeId = null;
  for (const [code, name] of LOCATION_TYPES) {
    const id = await ensure('location.location_type_master', 'location_type_id', { type_code: code },
      { type_code: code, type_name: name });
    if (code === 'WAREHOUSE') warehouseTypeId = id;
  }
  log('location types ok (Warehouse =', warehouseTypeId, ')');

  // ── business units (under the first existing organization) ──
  const org = (await sql`select organization_id from iam.org_master order by created_dt limit 1`)[0];
  let mfgBuId = null;
  if (org) {
    for (const [code, name] of BUSINESS_UNITS) {
      const id = await ensure('iam.business_unit_master', 'business_unit_id', { business_unit_code: code },
        { organization_id: org.organization_id, business_unit_code: code, business_unit_name: name });
      if (code === 'BU-MFG') mfgBuId = id;
    }
    log('business units ok (Manufacturing =', mfgBuId, ')');
    // wire org → registration country if unset
    if (indiaId) {
      const u = await sql`update iam.org_master set registration_country_id = ${indiaId}, updated_dt = now()
        where organization_id = ${org.organization_id} and registration_country_id is null`;
      if (u.count) log('org registration_country_id set → India');
    }
  } else {
    log('no organization found — skipping business units + org wiring');
  }

  // ── iam.organizations: the M01 org-management table behind /v1/organizations (SEPARATE from
  //    iam.org_master). Shipped empty → the admin "Organizations" screen was blank. Seed the company. ──
  const orgMgmtN = (await sql`select count(*)::int n from iam.organizations`)[0].n;
  if (orgMgmtN === 0) {
    // this table's created_by/updated_by are UUID user refs (not varchar) — use a real user id.
    const actor = (await sql`select user_id from iam.user_master order by created_dt limit 1`)[0];
    const actorId = actor ? actor.user_id : null;
    await sql`insert into iam.organizations (id, type, name, rera_no, gstin, status, created_at, updated_at, created_by, updated_by)
      values (gen_random_uuid(), 'MANUFACTURER', 'RAW AROMACHEM', null, '29ABCDE1234F1Z5', 'ACTIVE', now(), now(), ${actorId}, ${actorId})`;
    log('seeded iam.organizations (company)');
  } else {
    log('iam.organizations already has', orgMgmtN, 'row(s) — skipping');
  }

  // ── floors: one Ground Floor per warehouse ──
  const warehouses = await sql`select warehouse_id, warehouse_code from location.warehouse_master order by warehouse_code`;
  let firstFloorId = null;
  for (const w of warehouses) {
    // floor_code carries a global-unique constraint → scope it per warehouse.
    const code = 'GF-' + w.warehouse_code;
    const id = await ensure('location.floor_master', 'floor_id', { floor_code: code },
      { warehouse_id: w.warehouse_id, floor_code: code, floor_name: 'Ground Floor' });
    if (!firstFloorId) firstFloorId = id;
  }
  log('floors ok (', warehouses.length, 'warehouse(s), first floor =', firstFloorId, ')');

  // wire zones with a null floor to the first available floor
  if (firstFloorId) {
    const u = await sql`update location.zone_master set floor_id = ${firstFloorId}, updated_dt = now() where floor_id is null`;
    if (u.count) log('wired', u.count, 'zone(s) → floor', firstFloorId);
  }

  // ── bins: two per shelf ──
  const shelves = await sql`select shelf_id, shelf_code from location.shelf_master order by shelf_code`;
  let binCount = 0;
  for (const s of shelves) {
    for (const n of ['01', '02']) {
      const code = 'B-' + s.shelf_code + '-' + n;
      await ensure('location.bin_master', 'bin_id', { shelf_id: s.shelf_id, bin_code: code },
        { shelf_id: s.shelf_id, bin_code: code, bin_name: 'Bin ' + code });
      binCount++;
    }
  }
  log('bins ok (', binCount, 'across', shelves.length, 'shelf/shelves )');

  // ── wire location_master hierarchy refs where null ──
  if (org) {
    const u1 = await sql`update location.location_master set organization_id = ${org.organization_id}, updated_dt = now() where organization_id is null`;
    if (u1.count) log('wired', u1.count, 'location(s) → organization');
  }
  if (mfgBuId) {
    const u2 = await sql`update location.location_master set business_unit_id = ${mfgBuId}, updated_dt = now() where business_unit_id is null`;
    if (u2.count) log('wired', u2.count, 'location(s) → business unit');
  }
  if (warehouseTypeId) {
    const u3 = await sql`update location.location_master set location_type_id = ${warehouseTypeId}, updated_dt = now() where location_type_id is null`;
    if (u3.count) log('wired', u3.count, 'location(s) → location type');
  }

  // ── backfill user employee_code + mobile_number where null ──
  const users = await sql`select user_id, user_name from iam.user_master where employee_code is null or mobile_number is null order by user_name`;
  let idx = 0;
  for (const u of users) {
    idx += 1;
    const emp = 'EMP-' + String(u.user_name || 'user').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const mob = '+9199' + String(100000 + idx).slice(-6);
    await sql`update iam.user_master
      set employee_code = coalesce(employee_code, ${emp}),
          mobile_number = coalesce(mobile_number, ${mob}),
          updated_dt = now()
      where user_id = ${u.user_id}`;
  }
  log('backfilled employee_code/mobile_number for', users.length, 'user(s)');

  await sql.end();
  log('done.');
})().catch((e) => { console.error('[seed-master-hierarchy] FAILED:', e.message); process.exit(1); });
