/**
 * OPS-GREEN Act L (lane ops-factory) — the LABEL step. The label is composed from the FG batch's
 * own record, never typed in and never printed with blanks; packaging QC's label check cannot PASS
 * on a batch that carries no applied label.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { FgLabelService } from '../packaging-qc/fg-label.service.js';
import { PackagingQcService } from '../packaging-qc/packaging-qc.service.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let labels: FgLabelService;
let qc: PackagingQcService;

before(async () => {
  await ensureSchema();
  labels = new FgLabelService(testClient());
  qc = new PackagingQcService(testClient());
});
after(async () => { await closeTestClient(); });

async function fgBatch(opts: { complete: boolean }) {
  const sql = testClient();
  const id = crypto.randomUUID();
  const skuId = crypto.randomUUID();
  const uomId = crypto.randomUUID();
  await sql`insert into platform.uom_master (uom_id, uom_code, uom_name) values (${uomId}, ${'KG-' + id.slice(0, 8)}, 'Kilogram')`;
  await sql`insert into packaging.product_sku (product_sku_id, sku_code) values (${skuId}, ${'SKU-' + id.slice(0, 8)})`;
  await sql`insert into packaging.finished_good_batch_master
    (finished_good_batch_id, product_sku_id, batch_number, produced_qty, uom_id, manufacturing_date, expiry_date, status)
    values (${id}, ${skuId}, ${'FG-' + id.slice(0, 8)}, 12.5, ${uomId}, '2026-09-24',
            ${opts.complete ? '2028-09-24' : null}, 'ACTIVE')`;
  return id;
}

test('a label is composed from the batch record and recorded as APPLIED', async () => {
  const id = await fgBatch({ complete: true });
  const row = (await labels.apply(id, { labelCount: 12, labelContent: { mrp: '999' } }, principal())) as {
    labelCount: number; status: string; labelContent: Record<string, unknown> };
  assert.equal(row.status, 'APPLIED');
  assert.equal(row.labelCount, 12);
  assert.deepEqual(row.labelContent, {
    skuCode: 'SKU-' + id.slice(0, 8), batchNumber: 'FG-' + id.slice(0, 8),
    manufacturingDate: '2026-09-24', expiryDate: '2028-09-24', netQuantity: '12.5', unit: 'KG-' + id.slice(0, 8),
  });
  // Operator-supplied content (the 'mrp' above) never reaches the label.
  assert.equal('mrp' in row.labelContent, false);
  const listed = await labels.list(id);
  assert.equal(listed.items.length, 1);
});

test('a batch missing a field it would print is refused, not labelled blank; bad counts are 400', async () => {
  const id = await fgBatch({ complete: false });
  await assert.rejects(() => labels.apply(id, { labelCount: 1 }, principal()), ConflictException);
  const ok = await fgBatch({ complete: true });
  await assert.rejects(() => labels.apply(ok, { labelCount: 0 }, principal()), BadRequestException);
  await assert.rejects(() => labels.apply(ok, { labelCount: 1.5 }, principal()), BadRequestException);
});

test('packaging QC: label check PASS is refused on an unlabelled batch, accepted once labelled', async () => {
  const id = await fgBatch({ complete: true });
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
