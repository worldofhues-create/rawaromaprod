/* Factory: traceability. The chain from a finished batch back to the raw lot. */
import { expect, test } from '@playwright/test';
import { releasedFinishedBatch } from '../../harness/chain';
import { expectRefused, openNav, rowAction, signIn, sql, uniq } from '../../harness/walk';

test('owner traces a released batch to its oil and raw material; filling is refused', async ({ page }, info) => {
  const fgNo = uniq('FGT-', info);
  const { fg } = await releasedFinishedBatch(fgNo, 2);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Trace a batch');
  await rowAction(page, fgNo, 'Trace');
  await expect(page.locator('#ra-trace')).toContainText(`OB-${fgNo}`);
  await expect(page.locator('#ra-trace')).toContainText('CH-RM-1');
  await expect(page.locator('#ra-trace')).toContainText('Chain Aromatics');
  // The lot issued to this order, not merely some lot of the same material: this line is the recall.
  const lot = sql(`select b.batch_number from packaging.finished_good_batch_master f join packaging.package_order p using (package_order_id) join production.oil_batch_master o on o.oil_batch_id=p.oil_batch_id join production.material_issue mi on mi.production_order_id=o.production_order_id join production.material_issue_item i on i.material_issue_id=mi.material_issue_id join inventory.inventory_batch ib on ib.inventory_batch_id=i.inventory_batch_id join inventory.rm_batch_master b on b.rm_batch_id=ib.rm_batch_id where f.finished_good_batch_id='${fg}'`);
  expect(lot).not.toBe('');
  await expect(page.locator('#ra-trace')).toContainText(lot);
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'GET', `/v1/trace/finished-good/${fg}`);
});
