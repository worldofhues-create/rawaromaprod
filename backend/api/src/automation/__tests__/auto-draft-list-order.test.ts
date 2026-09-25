/**
 * RC7 item 1 — an automation-drafted purchase request / RFQ is the NEWEST row of its list.
 *
 * The procurement lists page by id, newest first (`order by <pk> desc`, keyset cursor `<pk> < cursor`), which is
 * right only because the tables' own default is uuidv7() — time-ordered. The material-shortage automation
 * (material-shortage.service.ts) supplied its own ids with randomUUID(), i.e. v4: a fresh draft landed at a
 * random position (seen live on the demo: this run's RFQ was 100th of 142). It now mints uuidv7 like the tables do.
 *
 * Runs against a database migrated exactly as production's is (scripts/db-migrate.ts, SKIP_TARGETS=formula):
 * the test harness's schema.sql defaults every id to gen_random_uuid(), so only the real migrations give the rows
 * the UI creates the ids production gives them. Needs the Docker PostGIS the gates use (the migrations create
 * PostGIS); its database is dropped and re-created on each run.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as procurementSchema from '@ra/data-procurement';
import { RequirementService } from '../../../../cluster-procurement/src/requirement/requirement.service.js';
import { RfqService } from '../../../../cluster-procurement/src/rfq/rfq.service.js';
import { principal } from '../../../../test-support/db.js';
import { MaterialShortageService } from '../material-shortage.service.js';

const REPO_ROOT = process.cwd(); // run-tests.mjs spawns `node --test` with cwd: repoRoot
const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://apple@localhost:5432/rawprod_rp_policy_test';
const dbUrl = (name: string) => { const u = new URL(BASE_URL); u.pathname = `/${name}`; return u.toString(); };
const DB = `${new URL(BASE_URL).pathname.replace(/^\//, '') || 'rawprod_test'}_list_order`.slice(0, 63);

let admin: Sql;
let sql: Sql;
let drizzleClient: Sql;
let requirements: RequirementService;
let rfqs: RfqService;
let shortage: MaterialShortageService;

function migrate(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/db-migrate.ts'], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: dbUrl(DB), SKIP_TARGETS: 'formula' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`db-migrate exited ${code}:\n${out.slice(-4000)}`))));
  });
}

const tick = () => new Promise((r) => setTimeout(r, 5)); // separate the millisecond timestamps of consecutive ids
const isV7 = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

before(async () => {
  admin = postgres(dbUrl('postgres'), { max: 1, prepare: false, onnotice: () => {} });
  const [postgis] = await admin`select 1 from pg_available_extensions where name = 'postgis'`;
  if (!postgis) throw new Error(`${new URL(BASE_URL).host} has no PostGIS, which the real migrations need -- use the Docker PostGIS (127.0.0.1:5433).`);
  await admin.unsafe(`drop database if exists "${DB}" with (force)`);
  await admin.unsafe(`create database "${DB}"`);
  await migrate();
  sql = postgres(dbUrl(DB), { max: 3, prepare: false, onnotice: () => {} });
  drizzleClient = postgres(dbUrl(DB), { max: 2, prepare: false, onnotice: () => {} });
  const db = drizzle(drizzleClient, { schema: procurementSchema });
  requirements = new RequirementService(db);
  rfqs = new RfqService(db);
  shortage = new MaterialShortageService(sql);
});

after(async () => {
  await sql?.end({ timeout: 1 });
  await drizzleClient?.end({ timeout: 1 });
  if (process.env.KEEP_LIST_ORDER_DB !== '1') await admin?.unsafe(`drop database if exists "${DB}" with (force)`);
  await admin?.end({ timeout: 1 });
});

/** A production order short of `materials` (no stock at all), optionally with a preferred vendor per material. */
async function shortOrder(materials: Array<{ vendorId?: string }>): Promise<string> {
  const [order] = await sql`insert into production.production_order (order_qty, status) values (100, 'PLANNING') returning production_order_id::text as id`;
  for (const m of materials) {
    const [mat] = await sql`select uuidv7()::text as id`;
    if (m.vendorId) {
      await sql`insert into procurement.vendor_rm_mapping (vendor_id, material_id, is_preferred, status) values (${m.vendorId}, ${mat!.id}, true, 'ACTIVE')`;
    }
    await sql`insert into production.production_order_ingredients (production_order_id, material_id, required_qty, status)
      values (${order!.id}, ${mat!.id}, 50, 'PENDING')`;
  }
  return order!.id as string;
}

async function applyOne(productionOrderId: string): Promise<{ purchaseRequestIds: string[]; rfqIds: string[] }> {
  await (shortage as unknown as { applyOne(id: string): Promise<void> }).applyOne(productionOrderId);
  const [log] = await sql`select outputs from automation.decision_log where dedupe_key = ${productionOrderId} and decision = 'FIRED'`;
  assert.ok(log, 'the shortage rule fired');
  // ledger.ts binds JSON.stringify(outputs) to a ::jsonb parameter: on a plain postgres-js client (this one) that
  // is stored as a JSON string, on the API's Drizzle-wrapped pool as the object. Read either.
  const outputs = typeof log!.outputs === 'string' ? JSON.parse(log!.outputs) : log!.outputs;
  return outputs as { purchaseRequestIds: string[]; rfqIds: string[] };
}

const prIds = async () => (await requirements.listPurchaseRequests({ limit: 50 })).items.map((r) => r.purchaseRequestId);
const rfqIdsListed = async () => (await rfqs.listRfqMasters({ limit: 50 })).items.map((r) => r.rfqId as string);

test('a newly auto-drafted PR and RFQ are first in their lists, above everything created before them', async () => {
  // Rows the UI created earlier: the services insert without an id, so they take the table default (uuidv7).
  const who = principal();
  const earlierPr = await requirements.createPurchaseRequest({ prNumber: 'PR-UI-EARLIER' } as never, who);
  const earlierRfq = await rfqs.createRfqMaster({ rfqNumber: 'RFQ-UI-EARLIER' } as never, who);
  assert.ok(isV7(earlierPr.purchaseRequestId), 'precondition: the table default is uuidv7');
  await tick();

  const { purchaseRequestIds: [autoPr], rfqIds: [autoRfq] } = await applyOne(await shortOrder([{}]));
  assert.ok(autoPr && autoRfq);
  assert.ok(isV7(autoPr), `the automation mints uuidv7 like the table default, got ${autoPr}`);
  assert.ok(isV7(autoRfq), `the automation mints uuidv7 like the table default, got ${autoRfq}`);

  assert.equal((await prIds())[0], autoPr, 'the new draft PR is first in the purchase-request list');
  assert.equal((await rfqIdsListed())[0], autoRfq, 'the new draft RFQ is first in the RFQ list');
  assert.ok((await prIds()).indexOf(earlierPr.purchaseRequestId) > 0);
  assert.ok((await rfqIdsListed()).indexOf(earlierRfq.rfqId) > 0);

  // ...and a row the UI creates afterwards goes above it, as newest-first means.
  await tick();
  const laterPr = await requirements.createPurchaseRequest({ prNumber: 'PR-UI-LATER' } as never, who);
  assert.deepEqual((await prIds()).slice(0, 3), [laterPr.purchaseRequestId, autoPr, earlierPr.purchaseRequestId]);
});

test('consecutive shortage runs list newest first, one draft after another', async () => {
  const drafted: string[] = [];
  const draftedRfqs: string[] = [];
  for (let i = 0; i < 5; i++) {
    const out = await applyOne(await shortOrder([{}]));
    drafted.push(out.purchaseRequestIds[0]!);
    draftedRfqs.push(out.rfqIds[0]!);
    await tick();
  }
  // With random (v4) ids this order held by chance only (1 in 120).
  assert.deepEqual((await prIds()).slice(0, 5), [...drafted].reverse());
  assert.deepEqual((await rfqIdsListed()).slice(0, 5), [...draftedRfqs].reverse());
});

test('two vendor groups drafted in the same run get distinct PR and RFQ numbers (unique indexes hold)', async () => {
  const [a] = await sql`insert into procurement.vendor_details (vendor_name, status) values ('List-order vendor A', 'ACTIVE') returning vendor_id::text as id`;
  const [b] = await sql`insert into procurement.vendor_details (vendor_name, status) values ('List-order vendor B', 'ACTIVE') returning vendor_id::text as id`;
  // A uuidv7's first 8 hex are its millisecond timestamp's top bits: both drafts of this run share them, so a
  // number cut from the HEAD of the id collided on purchase_request_pr_number_uq and the run failed.
  const out = await applyOne(await shortOrder([{ vendorId: a!.id as string }, { vendorId: b!.id as string }]));
  assert.equal(out.purchaseRequestIds.length, 2);
  const prs = await sql`select pr_number from procurement.purchase_request where purchase_request_id = any(${out.purchaseRequestIds}::uuid[])`;
  const rfqNumbers = await sql`select rfq_number from procurement.rfq_master where rfq_id = any(${out.rfqIds}::uuid[])`;
  assert.equal(new Set(prs.map((r) => r.pr_number)).size, 2, 'two distinct PR numbers');
  assert.equal(new Set(rfqNumbers.map((r) => r.rfq_number)).size, 2, 'two distinct RFQ numbers');
  for (const r of prs) assert.match(String(r.pr_number), /^PR-AUTO-[0-9A-F]{12}$/);
  for (const r of rfqNumbers) assert.match(String(r.rfq_number), /^RFQ-AUTO-[0-9A-F]{12}$/);
});

test('no server-side insert into an id-ordered table mints a random (v4) id any more', () => {
  // Every table these write lists newest-first by id (procurement PR/RFQ/stock requirement/PO/credit note, quality
  // qc_inspections, inventory inventory_batch, packaging finished_goods_batch_consumption). alerts.service.ts keeps
  // randomUUID() for platform.notification_log, whose readers order by created_dt, never by id.
  for (const f of [
    'backend/api/src/automation/material-shortage.service.ts',
    'backend/api/src/automation/incoming-qc-outcome.service.ts',
    'backend/api/src/automation/quarantine-intake.service.ts',
    'backend/api/src/automation/packaging-release.service.ts',
    'backend/api/src/procanalytics/procanalytics.service.ts',
    'backend/api/src/bridge/importer.service.ts',
  ]) {
    const code = readFileSync(join(REPO_ROOT, f), 'utf8');
    assert.doesNotMatch(code, /randomUUID\(|gen_random_uuid\(/, `${f} mints a v4 id`);
  }
});
