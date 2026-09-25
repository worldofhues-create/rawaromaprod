/**
 * Lane fread-rp — DashboardService.snapshot without formula.* on the main box. The runs table, the
 * formula stage of the chain-of-custody graph, the packaging stage and the activity feed used to
 * join formula.formula_version / formula_master / formula_event_hist, tables that exist only in
 * the Vault database: in production every one of those aggregates came back empty. Their formula
 * labels now come from the Vault over the signed channel (a recording stub here; the real channel
 * between two processes and two databases is vault-isolation-harness.test.ts).
 *
 * Proves: the Vault is asked for exactly this page's version ids and formula ids (+ the recent
 * block), once; a formula:actual:read holder sees the run's formula code + version, everyone else
 * the same mask as before; the formula stage shows codes; the feed shows event types only; an
 * unreachable Vault degrades to no labels instead of failing the page.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FormulaLabels, FormulaLabelsQuery } from '@ra/cluster-formula';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { DashboardService } from '../dashboard/dashboard.service.js';

const VERSION_ID = randomUUID();
const FORMULA_ID = randomUUID();
const OIL_BATCH = `OIL-FREAD-${randomUUID().slice(0, 8)}`;
const FG_BATCH = `00000000-FREAD-${randomUUID().slice(0, 8)}`;

const calls: FormulaLabelsQuery[] = [];
let vaultDown = false;
const vault = {
  formulaLabels: async (q: FormulaLabelsQuery): Promise<FormulaLabels> => {
    calls.push(q);
    if (vaultDown) throw new Error('The Formula Vault is unreachable');
    return {
      versions: q.formulaVersionIds.includes(VERSION_ID)
        ? [{ formulaVersionId: VERSION_ID, formulaId: FORMULA_ID, formulaCode: 'FRM-CITRUS-7', versionNumber: 2, status: 'APPROVED' }]
        : [],
      formulas: q.formulaIds.includes(FORMULA_ID) ? [{ formulaId: FORMULA_ID, formulaCode: 'FRM-CITRUS-7' }] : [],
      recent: q.recent
        ? {
            formulaCodes: ['FRM-A', 'FRM-B', 'FRM-C'],
            events: [{ eventType: 'VERSION_APPROVED', eventDt: new Date(Date.now() + 86_400_000 * 365 * 50).toISOString() }],
          }
        : null,
    };
  },
};

let svc: DashboardService;

before(async () => {
  await ensureSchema();
  const sql = testClient();
  svc = new DashboardService(sql, vault);
  // A run far in the future so it heads the runs table (order by actual_start_dt desc).
  const orderId = randomUUID();
  await sql`insert into production.production_order (production_order_id, formula_version_id, order_qty, status, actual_start_dt)
            values (${orderId}, ${VERSION_ID}, 25, 'INPROGRESS', now() + interval '75 years')`;
  await sql`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, produced_qty, status)
            values (${randomUUID()}, ${orderId}, ${OIL_BATCH}, 25, 'ACTIVE')`;
  // A finished good whose product has no name of its own (so its label is the formula's code).
  const productId = randomUUID();
  const skuId = randomUUID();
  await sql`insert into packaging.product_master (product_id, product_code, product_name, formula_id, status)
            values (${productId}, ${`PRD-${randomUUID().slice(0, 8)}`}, null, ${FORMULA_ID}, 'ACTIVE')`;
  await sql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, status) values (${skuId}, ${productId}, ${`SKU-${randomUUID().slice(0, 8)}`}, 'ACTIVE')`;
  await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, product_sku_id, batch_number, status)
            values (${randomUUID()}, ${skuId}, ${FG_BATCH}, 'ACTIVE')`;
});

after(async () => {
  await closeTestClient();
});

const holder = principal({ roles: ['qc'], permissions: ['formula:actual:read'] });
const nonHolder = principal({ roles: ['owner'], permissions: [] });

test('one Vault call per snapshot, for this page\'s version and formula ids plus the recent block', async () => {
  calls.length = 0;
  await svc.snapshot(holder);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.recent, true);
  assert.ok(calls[0]!.formulaVersionIds.includes(VERSION_ID));
  assert.ok(calls[0]!.formulaIds.includes(FORMULA_ID));
});

test('a formula:actual:read holder sees the run\'s formula code + version; the formula stage shows codes', async () => {
  const snap = await svc.snapshot(holder);
  const run = snap.runs.find((r) => r.batch === OIL_BATCH);
  assert.ok(run, 'the seeded run heads the runs table');
  assert.equal(run.product, 'FRM-CITRUS-7 v2');
  assert.equal(run.cls, 'natural', 'the class chip reads the code (citrus), not a name');
  assert.equal(snap.flow.formula.count, 3);
  assert.deepEqual(snap.flow.formula.codes, [{ code: 'FRM-A', sub: 'recipe sealed' }, { code: 'FRM-B', sub: 'recipe sealed' }]);
  const fg = snap.flow.packaging.codes.find((c) => c.code === FG_BATCH);
  assert.ok(fg, 'the seeded finished good heads the packaging stage');
  assert.equal(fg.sub, 'FRM-CITRUS-7');
});

test('everyone else keeps the old mask (run "Protected ◆", finished good "sealed & labelled"); formula codes as before', async () => {
  const snap = await svc.snapshot(nonHolder);
  const run = snap.runs.find((r) => r.batch === OIL_BATCH);
  assert.ok(run);
  assert.equal(run.product, 'Protected ◆');
  assert.deepEqual(snap.flow.formula.codes.map((c) => c.code), ['FRM-A', 'FRM-B']);
  assert.ok(snap.flow.formula.codes.every((c) => c.sub === 'protected ◆'));
  assert.equal(snap.flow.packaging.codes.find((c) => c.code === FG_BATCH)?.sub, 'sealed & labelled');
});

test('the feed shows a formula event by its type only', async () => {
  const snap = await svc.snapshot(nonHolder);
  // At most 3 QC rows + this 1 event: all fit in the feed's 6.
  assert.ok(snap.feed.some((f) => f.text === 'version approved'), JSON.stringify(snap.feed));
});

test('an unreachable Vault degrades to no formula labels; the dashboard still renders', async () => {
  vaultDown = true;
  try {
    const snap = await svc.snapshot(holder);
    const run = snap.runs.find((r) => r.batch === OIL_BATCH);
    assert.ok(run, 'the runs table no longer depends on formula data to exist');
    assert.equal(run.product, '—');
    assert.equal(snap.flow.formula.count, 0);
    assert.ok(snap.counts.runsTotal >= 1);
  } finally {
    vaultDown = false;
  }
});
