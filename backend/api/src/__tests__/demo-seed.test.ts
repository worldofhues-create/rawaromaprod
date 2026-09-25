/**
 * demo-seed.test.ts (lane D3) — exercises scripts/demo-seed.ts (the "ALEMBIC OS Demo Factory"
 * seed program) against this lane's OWN throwaway database (parallel-lane rule: never another
 * lane's DB). Three things the lane brief asks this test to prove:
 *
 *   1. run twice -> same counts (idempotent, by natural/business key — see demo-seed.ts's own
 *      header for the strategy). Checked here as identical row counts, per table, across two
 *      back-to-back runs against a fresh database — not just "no duplicate-key errors".
 *   2. each factory workspace list endpoint is non-empty for the demo org (materials, vendors,
 *      purchase requests/RFQs/purchase orders, GRNs, QC inspections, production orders, package
 *      orders, finished-good batches, dispatches, formulas — via the REAL cluster services, the
 *      same classes demo-seed.ts itself drives).
 *   3. nothing written outside the demo org — the only real org-scoping surface in this schema
 *      is iam.org_master/user_master (every downstream domain table is an id-only soft ref with
 *      no organization_id column at all — confirmed while building the seed script); this test
 *      asserts exactly one org row (the demo org) exists and every user this seed created is
 *      bound to it.
 *
 * Run: TEST_DATABASE_URL=postgres://apple@localhost:5432/rawprod_d3_test
 *      FORMULA_TEST_DATABASE_URL=postgres://apple@localhost:5432/rawprod_d3_test
 *      pnpm test   (backend/test-support/run-tests.mjs picks up every backend/**\/*.test.ts,
 *      this file included, against whichever TEST_DATABASE_URL is set for the whole run — the
 *      same per-lane-env-var convention every other lane's test file already relies on).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema,
  TEST_DATABASE_URL,
  procurementDb,
  inventoryDb,
  qualityDb,
  productionDb,
  packagingDb,
  salesDb,
  orgDb,
  closeTestClient,
} from '../../../test-support/db.js';
import {
  ensureSchema as ensureFormulaSchema,
  TEST_DATABASE_URL as FORMULA_TEST_DATABASE_URL,
  closeTestClient as closeFormulaClient,
} from '../../../cluster-formula/src/__tests__/db.js';
import { runDemoSeed, type DemoSeedSummary } from '../../../../scripts/demo-seed.js';

import { VendorService } from '../../../cluster-procurement/src/vendor/vendor.service.js';
import { RequirementService } from '../../../cluster-procurement/src/requirement/requirement.service.js';
import { RfqService } from '../../../cluster-procurement/src/rfq/rfq.service.js';
import { PoService } from '../../../cluster-procurement/src/po/po.service.js';
import { GrnService } from '../../../cluster-inventory/src/grn/grn.service.js';
import { BatchService as InventoryBatchService } from '../../../cluster-inventory/src/batch/batch.service.js';
import { InspectionsService } from '../../../cluster-quality/src/inspections/inspections.service.js';
import { PlanningService } from '../../../cluster-production/src/planning/planning.service.js';
import { OrdersService as PackagingOrdersService } from '../../../cluster-packaging/src/orders/orders.service.js';
import { BatchService as PackagingBatchService } from '../../../cluster-packaging/src/batch/batch.service.js';
import { DispatchService } from '../../../cluster-sales/src/dispatch/dispatch.service.js';
import { PackagingLookupService } from '../../../cluster-packaging/src/packaging-lookup.service.js';
import { FormulasService } from '../../../cluster-formula/src/formulas/formulas.service.js';
import { VaultService } from '../../../cluster-formula/src/vault.service.js';
import { EnvKmsAdapter } from '../../../cluster-formula/src/crypto/env-kms.adapter.js';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { MasterdataLookupService } from '../../../cluster-masterdata/src/masterdata-lookup.service.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as masterdataSchema from '@ra/data-masterdata';
import * as formulaSchema from '@ra/data-formula';
import { orgMaster, userMaster } from '@ra/data-org';

/** A no-op stand-in for the one dependency these list-only calls never touch. */
const unusedFormulaLookup = {
  async resolveManufacturingInstruction() { return null; },
  async resolvePickList() { return null; },
};

const TABLES: Array<[string, string]> = [
  ['masterdata', 'material'], ['procurement', 'vendor_details'], ['procurement', 'vendor_rm_mapping'],
  ['procurement', 'stock_requirement'], ['procurement', 'purchase_request'], ['procurement', 'purchase_request_items'],
  ['procurement', 'rfq_master'], ['procurement', 'quotations'], ['procurement', 'purchase_order'],
  ['procurement', 'purchase_order_items'], ['procurement', 'vendor_credit_note'],
  ['inventory', 'gate_entry_master'], ['inventory', 'grn_master'], ['inventory', 'rm_batch_master'],
  ['inventory', 'inventory_batch'], ['inventory', 'stock_reservation'], ['inventory', 'stock_transfer'],
  ['quality', 'qc_inspections'], ['quality', 'qc_result_details'], ['quality', 'qc_disposition'],
  ['bridge', 'production_requirement'], ['production', 'production_order'], ['production', 'production_order_ingredients'],
  ['production', 'secure_mixing_session'], ['production', 'oil_batch_master'],
  ['packaging', 'package_order'], ['packaging', 'filling_session'], ['packaging', 'finished_good_batch_master'],
  ['packaging', 'packaging_qc'], ['packaging', 'finished_good_reservation'],
  ['sales', 'sales_order'], ['sales', 'sales_order_items'], ['sales', 'dispatch_master'], ['sales', 'dispatch_items'],
  ['automation', 'applied'], ['automation', 'decision_log'], ['automation', 'dead_letter'],
  ['platform', 'notification_log'], ['platform', 'tutorial_progress'],
  ['iam', 'user_master'], ['iam', 'org_master'], ['iam', 'role_master'], ['iam', 'user_role_mapping'],
  ['formula', 'formula_master'], ['formula', 'formula_version'], ['formula', 'formula_ingredients'],
  ['formula', 'formula_approval'],
];

let rawSql: ReturnType<typeof postgres>;
let summary2: DemoSeedSummary;

async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [schema, tbl] of TABLES) {
    const rows = await rawSql.unsafe(`select count(*)::int as c from ${schema}.${tbl}`);
    out[`${schema}.${tbl}`] = Number((rows[0] as unknown as { c: number }).c);
  }
  return out;
}

before(async () => {
  await ensureSchema();
  await ensureFormulaSchema();
  // Align with the formula-cluster test suite's OWN shared fixture KEK (vault-lifecycle.test.ts,
  // vault-sod.test.ts, manufacturing-instruction.test.ts, vault-rewrap.test.ts all hardcode this
  // exact value) rather than demo-seed.ts's own derived default. This lane's env deliberately
  // points TEST_DATABASE_URL and FORMULA_TEST_DATABASE_URL at the SAME physical database, so
  // formula.audit_events is one shared, globally hash-chained table across every test file in a
  // `pnpm test` run — every writer to it in this run must sign under the SAME KEK, or a formula
  // test file that runs after this one (and calls VaultService.verifyAuditChain()) sees rows
  // this file wrote under a different key and reports a broken chain. Set only when unset, so a
  // real `FORMULA_KEK` provided to the test run still wins.
  process.env.FORMULA_KEK = process.env.FORMULA_KEK ?? 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
  rawSql = postgres(TEST_DATABASE_URL, { max: 3, prepare: false });
});

after(async () => {
  await rawSql.end({ timeout: 5 });
  await closeTestClient();
  await closeFormulaClient();
});

test('demo-seed: run twice produces byte-identical row counts across every seeded table', async () => {
  const opts = { databaseUrl: TEST_DATABASE_URL, formulaDatabaseUrl: FORMULA_TEST_DATABASE_URL, quiet: true };

  const summary1 = await runDemoSeed(opts);
  const snap1 = await snapshot();

  summary2 = await runDemoSeed(opts);
  const snap2 = await snapshot();

  assert.ok(summary1.materials > 0 && summary1.purchaseOrders > 0, 'first run actually seeded something');

  for (const key of Object.keys(snap1)) {
    assert.equal(snap2[key], snap1[key], `table ${key} count changed between run 1 (${snap1[key]}) and run 2 (${snap2[key]}) — not idempotent`);
  }
});

test('demo-seed: every factory workspace list endpoint is non-empty for the demo org (real services)', async () => {
  const vendorSvc = new VendorService(procurementDb());
  const reqSvc = new RequirementService(procurementDb());
  const rfqSvc = new RfqService(procurementDb());
  const poSvc = new PoService(procurementDb());
  const grnSvc = new GrnService(inventoryDb());
  const rmBatchSvc = new InventoryBatchService(inventoryDb());
  const qcSvc = new InspectionsService(qualityDb());
  const planningSvc = new PlanningService(productionDb(), unusedFormulaLookup);
  const pkgOrdersSvc = new PackagingOrdersService(packagingDb());
  const pkgBatchSvc = new PackagingBatchService(packagingDb());
  const pkgLookup = new PackagingLookupService(packagingDb());
  const dispatchSvc = new DispatchService(salesDb(), pkgLookup);

  const formulaSql = postgres(FORMULA_TEST_DATABASE_URL, { max: 2, prepare: false });
  const masterdataSql = postgres(TEST_DATABASE_URL, { max: 2, prepare: false });
  try {
    const formulaDb = drizzle(formulaSql, { schema: formulaSchema });
    const kms = new EnvKmsAdapter(new ConfigService(process.env));
    const vault = new VaultService(formulaDb, kms);
    const masterdataLookup = new MasterdataLookupService(drizzle(masterdataSql, { schema: masterdataSchema }));
    const formulasSvc = new FormulasService(formulaDb, kms, vault, masterdataLookup);

    const q = { limit: 20 };
    const checks: Array<[string, { items: unknown[] }]> = [
      ['vendors', await vendorSvc.listVendorDetails(q)],
      ['purchase requests', await reqSvc.listPurchaseRequests(q)],
      ['RFQs', await rfqSvc.listRfqMasters(q)],
      ['purchase orders', await poSvc.listPurchaseOrders(q)],
      ['GRNs', await grnSvc.listGrns(q)],
      ['RM batches', await rmBatchSvc.listRmBatches(q)],
      ['QC inspections', await qcSvc.listInspections(q)],
      ['production orders', await planningSvc.listOrders(q)],
      ['package orders', await pkgOrdersSvc.listPackageOrders(q)],
      ['finished-good batches', await pkgBatchSvc.listFinishedGoodBatches(q)],
      ['dispatches', await dispatchSvc.listDispatches(q)],
      ['formulas', await formulasSvc.listFormulas(q)],
    ];
    for (const [label, page] of checks) {
      assert.ok(Array.isArray(page.items) && page.items.length > 0, `${label} list endpoint returned no items for the demo org`);
    }
  } finally {
    await formulaSql.end({ timeout: 5 });
    await masterdataSql.end({ timeout: 5 });
  }
});

test('demo-seed: nothing written outside the demo org', async () => {
  const orgs = await orgDb().select().from(orgMaster);
  assert.equal(orgs.length, 1, `expected exactly one org (the demo org), found ${orgs.length}`);
  const demoOrg = orgs[0]!;
  assert.equal(demoOrg.organizationCode, 'ALEMBIC-OS-DEMO-FACTORY');

  const users = await orgDb().select().from(userMaster);
  assert.ok(users.length > 0, 'expected demo users to exist');
  for (const u of users) {
    assert.equal(
      u.organizationId,
      demoOrg.organizationId,
      `user ${u.email} is bound to a different organization than the demo org`,
    );
  }
});

test('demo-seed: summary reports the real, freshly-driven retry + dead-letter automation demo', () => {
  assert.equal(summary2.automationRetryDemo, 'recovered');
  assert.equal(summary2.automationDeadLetterDemo, 'dead-lettered');
});
