/* Factory: production QC and CAPA. */
import { expect, test } from '@playwright/test';
import { master, must, receivedLot, releasedOil } from '../../harness/chain';
import { createViaForm, expectRefused, openNav, signIn, sql, uniq } from '../../harness/walk';

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

  const { insp } = await receivedLot(1);
  const code = uniq('CAPA-', info);
  const capa = (await must('qc', 'POST', '/v1/qc-capas', { qcInspectionId: insp, capaCode: code, capaType: 'SUPPLIER', description: 'walk', rootCause: 'walk', actionPlan: 'walk', dueDt: '2031-10-15' })).qcCapaId;
  await must('qc', 'POST', `/v1/qc-capas/${capa}/start`, {});
  await must('qc', 'POST', `/v1/qc-capas/${capa}/close`, { closureEvidence: 'walk evidence' });
  await expectRefused(page, 'POST', `/v1/qc-capas/${capa}/verify`, {});
  await must('owner', 'POST', `/v1/qc-capas/${capa}/verify`, { remarks: 'verified' });
  expect(sql(`select status from quality.qc_capa where qc_capa_id='${capa}'`)).toBe('VERIFIED');
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Corrective actions');
  await expect(page.locator('#ra-results')).toContainText(code);
});

test('packaging is refused a production QC record', async ({ page }) => {
  await signIn(page, 'factory', 'packaging');
  await expect(page.locator('#ra-side .who small')).toHaveText('Packaging');
  await expectRefused(page, 'POST', '/v1/production-qc', { oilBatchId: '00000000-0000-0000-0000-000000000000', result: 'PASS' });
});
