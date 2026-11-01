/* Factory: traceability. The chain from a finished batch back to the raw lot. */
import { expect, test } from '@playwright/test';
import { releasedFinishedBatch } from '../../harness/chain';
import { expectRefused, openNav, rowAction, signIn, uniq } from '../../harness/walk';

test('owner traces a released batch to its oil and raw material; filling is refused', async ({ page }, info) => {
  const fgNo = uniq('FGT-', info);
  const { fg } = await releasedFinishedBatch(fgNo, 2);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Trace a batch');
  await rowAction(page, fgNo, 'Trace');
  await expect(page.locator('#ra-trace')).toContainText(`OB-${fgNo}`);
  await expect(page.locator('#ra-trace')).toContainText('CH-RM-1');
  await expect(page.locator('#ra-trace')).toContainText('Chain Aromatics');
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'GET', `/v1/trace/finished-good/${fg}`);
});
