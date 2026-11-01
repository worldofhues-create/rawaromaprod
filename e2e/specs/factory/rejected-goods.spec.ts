/* Factory: rejected goods, settlement, vendor ledger. */
import { expect, test } from '@playwright/test';
import { master, must, receivedLot, until } from '../../harness/chain';
import { confirmDialog, expectRefused, openNav, rowAction, searchFor, signIn, sql, createViaForm } from '../../harness/walk';

test('a rejected lot appears for procurement with its drafted credit note, and a settlement reads back', async ({ page }, info) => {
  const { qcParam } = await master();
  const lot = await receivedLot(2); const { insp, rmBatch, grnId, grnNumber } = lot;
  await must('qc', 'POST', `/v1/qc-inspections/${insp}/results`, { results: [{ qcParameterId: qcParam, observedValue: 1.52, result: 'FAIL' }] });
  const { batchNumber } = lot;
  await signIn(page, 'factory', 'qc');
  await openNav(page, 'Test queue');
  await searchFor(page, batchNumber);
  await rowAction(page, batchNumber, 'Reject');
  await confirmDialog(page, 'Reject');
  await until('the credit note draft', async () => sql(`select count(*) from procurement.vendor_credit_note where grn_id='${grnId}'`) === '1');
  expect(sql(`select status from inventory.rm_batch_master where rm_batch_id='${rmBatch}'`)).toBe('REJECTED');

  await signIn(page, 'factory', 'procurement');
  await openNav(page, 'Rejected deliveries');
  await expect(page.locator('#ra-results')).toContainText(grnNumber);
  await openNav(page, 'Supplier credit notes');
  await expect(page.locator('#ra-results')).toContainText(/draft/i);
  const number = `CN-${info.project.name.endsWith('375') ? 'M' : 'D'}${Date.now()}`;
  await createViaForm(page, { vendorId: { label: 'Chain Aromatics (test)' }, creditNoteNumber: number, amount: 240, creditNoteDate: '2031-05-04' });
  await expect(page.locator('#ra-results')).toContainText(number);
  await page.reload();
  await expect(page.locator('#ra-results')).toContainText(number);
  expect(sql(`select count(*) from procurement.vendor_credit_note where credit_note_number='${number}'`)).toBe('1');
  await openNav(page, 'Supplier ledger');
  await expect(page.locator('#ra-view')).toContainText('Chain Aromatics');
});

test('filling is refused a settlement', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'POST', '/v1/vendor-credit-notes', { creditNoteNumber: 'NO' });
});
