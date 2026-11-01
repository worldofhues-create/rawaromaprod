/* Factory: production QC and CAPA. */
import { expect, test } from '@playwright/test';
import { master, receivedLot, releasedOil } from '../../harness/chain';
import { confirmIfAsked, createViaForm, expectRefused, openNav, rowById, signIn, sql, uniq } from '../../harness/walk';

test('QC records an in-process result on a batch; a CAPA moves to verified only by someone else', async ({ page }, info) => {
  const batch = uniq('OBQ-', info);
  await master();
  const { oil } = await releasedOil(batch, 2);
  await signIn(page, 'factory', 'qc');
  await openNav(page, 'Production QC');
  const before = Number(sql(`select count(*) from production.production_qc where oil_batch_id='${oil}'`));
  await createViaForm(page, { oilBatchId: { label: batch }, result: 'PASS', observedValue: 1.47 });
  expect(Number(sql(`select count(*) from production.production_qc where oil_batch_id='${oil}'`))).toBe(before + 1);
  await page.reload();
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();

  await receivedLot(1);
  const code = uniq('CAPA-', info);
  await openNav(page, 'Corrective actions');
  await createViaForm(page, { capaCode: code, capaType: 'SUPPLIER', description: 'walk', rootCause: 'walk', actionPlan: 'walk' });
  const id = sql(`select qc_capa_id from quality.qc_capa where capa_code='${code}'`);
  expect(id).not.toBe('');
  const status = () => sql(`select status from quality.qc_capa where qc_capa_id='${id}'`);
  const press = (label: string) => rowById(page, id).getByRole('button', { name: label, exact: true }).click();
  await press('Start');
  await confirmIfAsked(page, 'Start');
  await expect.poll(status).toBe('IN_PROGRESS');
  await press('Close');
  await page.getByLabel('What shows it is fixed?').fill('walk evidence');
  await page.getByRole('button', { name: 'Close action', exact: true }).click();
  await expect.poll(status).toBe('CLOSED');
  // The author is offered no Verify, and the server agrees.
  await expect(rowById(page, id).getByRole('button', { name: 'Verify', exact: true })).toHaveCount(0);
  await expectRefused(page, 'POST', `/v1/qc-capas/${id}/verify`, {});
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Corrective actions');
  await press('Verify');
  await confirmIfAsked(page, 'Verify');
  await expect.poll(status).toBe('VERIFIED');
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Corrective actions');
  await expect(page.locator('#ra-new')).toHaveCount(0);
  await expect(rowById(page, id)).toBeVisible();
});

test('packaging is refused a production QC record', async ({ page }) => {
  await signIn(page, 'factory', 'packaging');
  await expect(page.locator('#ra-side .who small')).toHaveText('Packaging');
  await expectRefused(page, 'POST', '/v1/production-qc', { oilBatchId: '00000000-0000-0000-0000-000000000000', result: 'PASS' });
});
