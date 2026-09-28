/**
 * OPS-GREEN Act L (lane ops-factory) — the LABEL step. The label is composed from the records,
 * never typed in and never printed with blanks; packaging QC's label check cannot PASS on a batch
 * that carries no applied label.
 *
 * Lane produce (owner requirement 2026-09-29): only a QC-RELEASED batch is labelled (a failed —
 * or never-released — batch is refused, and a FAILED one raises an alert); the label carries the
 * product, batch, SKU + pack size, net quantity, mfg/expiry, QC status, the DG/hazard block where
 * the product has one, and the RACK assigned for put-away before the label prints.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { FgLabelService } from '../packaging-qc/fg-label.service.js';
import { PackagingQcService } from '../packaging-qc/packaging-qc.service.js';
import { ProductDgService } from '../packaging-qc/product-dg.service.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { finishedGood, rack } from '../../../test-support/produce-fixtures.js';

let labels: FgLabelService;
let qc: PackagingQcService;
let dg: ProductDgService;

before(async () => {
  await ensureSchema();
  labels = new FgLabelService(testClient());
  qc = new PackagingQcService(testClient());
  dg = new ProductDgService(testClient());
});
after(async () => { await closeTestClient(); });

test('a label is composed from the records — product, batch, pack size, net qty, dates, QC, DG, rack — and recorded as APPLIED', async () => {
  const r = await rack();
  const fg = await finishedGood({ coa: 'RELEASED' });
  await dg.set(fg.productId, { unNumber: 'UN1197', properShippingName: 'Extracts, flavouring, liquid', dgClass: '3', packingGroup: 'III',
    signalWord: 'Warning', hazardStatements: 'H226 Flammable liquid and vapour.' }, principal());
  const row = (await labels.apply(fg.fgBatchId, { labelCount: 12, labelContent: { mrp: '999' } }, principal())) as {
    labelCount: number; status: string; labelContent: Record<string, unknown> };
  assert.equal(row.status, 'APPLIED');
  assert.equal(row.labelCount, 12);
  const c = row.labelContent;
  assert.equal(c.skuCode, fg.skuCode);
  assert.equal(c.batchNumber, fg.fgBatchNo);
  assert.equal(c.manufacturingDate, '2026-09-22');
  assert.equal(c.expiryDate, '2028-09-20');
  assert.equal(c.netQuantity, '4');
  assert.equal(c.productCode, fg.productCode);
  assert.equal(c.productName, 'Althair');
  assert.equal(c.packSize, '25 kg');
  assert.equal(c.qcStatus, 'RELEASED');
  assert.equal(c.qcReleasedAt, '2026-09-21T09:30:00.000Z');
  assert.deepEqual(c.dg, { unNumber: 'UN1197', properShippingName: 'Extracts, flavouring, liquid', dgClass: '3', packingGroup: 'III',
    signalWord: 'Warning', hazardStatements: 'H226 Flammable liquid and vapour.' });
  // The rack assigned for put-away is on the label (an empty bin, earliest in the walk).
  assert.ok(typeof c.rack === 'string' && (c.rack as string).length > 0, 'the label carries a rack');
  assert.equal(c.rackAssigned, true);
  const task = await testClient()`select t.status, b.bin_code from location.shelf_task t join location.bin_master b on b.bin_id = t.to_bin_id
                                   where t.finished_good_batch_id = ${fg.fgBatchId} and t.kind = 'PUTAWAY'`;
  assert.equal(task.length, 1);
  assert.equal(task[0]!.status, 'OPEN');
  assert.equal(c.rack, task[0]!.bin_code, 'the label and the put-away task name the same bin');
  assert.ok(r.bins.length > 0);
  // Operator-supplied content (the 'mrp' above) never reaches the label.
  assert.equal('mrp' in c, false);
  const listed = await labels.list(fg.fgBatchId);
  assert.equal(listed.items.length, 1);
  // The printable preview composes the same content without recording anything.
  const preview = await labels.preview(fg.fgBatchId, principal());
  assert.equal(preview.rack, c.rack);
  assert.equal((await labels.list(fg.fgBatchId)).items.length, 1);
});

test('a product with no DG row prints no DG block', async () => {
  await rack();
  const fg = await finishedGood({ coa: 'RELEASED' });
  const preview = await labels.preview(fg.fgBatchId, principal());
  assert.equal(preview.dg, null);
});

test('QC gate: a failed batch is never labelled and raises an alert; a pending or untraceable one is refused', async () => {
  const failed = await finishedGood({ coa: 'TESTED_FAIL' });
  await assert.rejects(() => labels.apply(failed.fgBatchId, { labelCount: 1 }, principal()),
    (e: unknown) => e instanceof ConflictException && /failed QC — it cannot be labelled/.test((e as Error).message));
  const alert = await testClient()`select kind, roles from production.produce_alert where dedupe_key = ${`label_blocked:${failed.fgBatchId}`}`;
  assert.equal(alert.length, 1);
  assert.equal(alert[0]!.kind, 'label_blocked');
  assert.equal((await testClient()`select 1 from packaging.fg_label_record where finished_good_batch_id = ${failed.fgBatchId}`).length, 0);

  const rejected = await finishedGood({ coa: 'REJECTED' });
  await assert.rejects(() => labels.apply(rejected.fgBatchId, { labelCount: 1 }, principal()), /failed QC/);

  const pending = await finishedGood({ coa: 'TESTED_PASS' });
  await assert.rejects(() => labels.apply(pending.fgBatchId, { labelCount: 1 }, principal()), /not been released by QC/);
  const none = await finishedGood({ coa: 'NONE' });
  await assert.rejects(() => labels.preview(none.fgBatchId, principal()), /not been released by QC/);

  // A finished good not traceable to an oil batch cannot prove its QC.
  const sql = testClient();
  const orphan = crypto.randomUUID();
  await sql`insert into packaging.finished_good_batch_master (finished_good_batch_id, product_sku_id, batch_number, produced_qty, manufacturing_date, expiry_date, status)
            values (${orphan}, ${pending.skuId}, ${'FG-' + orphan.slice(0, 8)}, 1, '2026-09-24', '2028-09-24', 'ACTIVE')`;
  await assert.rejects(() => labels.apply(orphan, { labelCount: 1 }, principal()), /not linked to a compounded/);
});

test('a batch missing a field it would print is refused, not labelled blank; bad counts are 400', async () => {
  await rack();
  const incomplete = await finishedGood({ coa: 'RELEASED', expiryDate: null });
  await assert.rejects(() => labels.apply(incomplete.fgBatchId, { labelCount: 1 }, principal()), ConflictException);
  assert.equal((await testClient()`select 1 from location.shelf_task where finished_good_batch_id = ${incomplete.fgBatchId}`).length, 0,
    'no put-away task is opened for a batch that cannot be labelled');
  const ok = await finishedGood({ coa: 'RELEASED' });
  await assert.rejects(() => labels.apply(ok.fgBatchId, { labelCount: 0 }, principal()), BadRequestException);
  await assert.rejects(() => labels.apply(ok.fgBatchId, { labelCount: 1.5 }, principal()), BadRequestException);
});

test('packaging QC: label check PASS is refused on an unlabelled batch, accepted once labelled', async () => {
  await rack();
  const fg = await finishedGood({ coa: 'RELEASED' });
  const id = fg.fgBatchId;
  await assert.rejects(
    () => qc.create({ finishedGoodBatchId: id, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' }, principal()),
    ConflictException,
  );
  // A FAIL/HOLD label check needs no label (that IS the finding).
  const held = (await qc.create({ finishedGoodBatchId: id, leakageCheck: 'PASS', labelCheck: 'HOLD', cartonCheck: 'PASS' }, principal())) as { overallResult: string };
  assert.equal(held.overallResult, 'HOLD');
  await labels.apply(id, { labelCount: 1 }, principal());
  const passed = (await qc.create({ finishedGoodBatchId: id, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' }, principal())) as { overallResult: string };
  assert.equal(passed.overallResult, 'PASS');
});

test('DG info: validated per field; empty fields print nothing', async () => {
  const fg = await finishedGood({ coa: 'RELEASED' });
  await assert.rejects(() => dg.set(fg.productId, { unNumber: 'twelve' }, principal()), BadRequestException);
  await assert.rejects(() => dg.set(fg.productId, { packingGroup: 'IV' }, principal()), BadRequestException);
  const saved = await dg.set(fg.productId, { unNumber: '1197', dgClass: '3' }, principal()) as Record<string, unknown>;
  assert.equal(saved.unNumber, '1197');
  assert.equal(saved.packingGroup, null);
});
