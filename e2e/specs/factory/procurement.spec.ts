/* Factory: stock planning, PR, RFQ, quotation, PO. Every document raised on its own screen, with the
 * submitter/approver separation shown on the real buttons. */
import { expect, test } from '@playwright/test';
import { master, must } from '../../harness/chain';
import { createDoc, createViaForm, expectRefused, openNav, rowAction, searchFor, signIn, sql, uniq } from '../../harness/walk';

test('stock requirement -> PR -> approved by another -> RFQ -> quote -> PO, each row read back', async ({ page }, info) => {
  const c = uniq('P', info);
  await master();
  await signIn(page, 'factory', 'procurement');
  await openNav(page, 'Stock planning');
  await createViaForm(page, { materialId: { label: 'Chain raw material' }, requiredQty: 40, priority: 'HIGH', requiredByDate: '2031-06-01', requirementSource: `WALK-${c}` });
  await expect(page.locator('#ra-results')).toContainText('40');
  expect(sql(`select count(*) from procurement.stock_requirement where requirement_source='WALK-${c}'`)).toBe('1');

  await openNav(page, 'Purchase requests');
  await createViaForm(page, { prNumber: `PR-${c}`, priority: 'HIGH', expectedDeliveryDate: '2031-06-01' });
  await searchFor(page, `PR-${c}`);
  await rowAction(page, `PR-${c}`, 'Submit');
  await expect(page.locator('#ra-results tr').filter({ hasText: `PR-${c}` })).toContainText(/submitted/i);
  // Procurement raised it, so its own Approve button is not offered, and the server says the same.
  await expect(page.locator('#ra-results tr').filter({ hasText: `PR-${c}` }).getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  const prId = sql(`select purchase_request_id from procurement.purchase_request where pr_number='PR-${c}'`);
  await expectRefused(page, 'POST', `/v1/purchase-requests/${prId}/approve`, {});

  await must('owner', 'POST', `/v1/purchase-requests/${prId}/approve`, { remarks: 'walk' });
  await page.reload();
  await expect(page.locator('#ra-title')).toHaveText('Purchase requests');
  await searchFor(page, `PR-${c}`);
  await expect(page.locator('#ra-results tr').filter({ hasText: `PR-${c}` })).toContainText(/approved/i);

  await openNav(page, 'Quote requests');
  await createViaForm(page, { rfqNumber: `RFQ-${c}`, purchaseRequestId: { label: `PR-${c}` }, rfqDate: '2031-05-01', submissionDeadline: '2031-05-08' });
  await searchFor(page, `RFQ-${c}`);

  await openNav(page, 'Supplier quotes');
  await createViaForm(page, { quotationNumber: `Q-${c}`, rfqId: { label: `RFQ-${c}` }, vendorId: { label: 'Chain Aromatics (test)' }, quotationDate: '2031-05-02', validUntilDate: '2031-06-02' });
  await searchFor(page, `Q-${c}`);

  await openNav(page, 'Quote lines');
  await createViaForm(page, { quotationId: { label: `Q-${c}` }, materialId: { label: 'Chain raw material' }, quotedQty: 40, uomId: { label: 'CH-KG' }, quotedRate: 120 });

  await openNav(page, 'Supplier quotes');
  await searchFor(page, `Q-${c}`);
  await rowAction(page, `Q-${c}`, 'Select as final vendor');
  await expect.poll(() => sql(`select status from procurement.quotations where quotation_number='Q-${c}'`)).toBe('SELECTED');

  await openNav(page, 'Purchase orders');
  await createDoc(page, { poNumber: `PO-${c}`, vendorId: { label: 'Chain Aromatics (test)' }, orderDate: '2031-05-03' }, { materialId: { label: 'Chain raw material' }, orderedQty: 2.5, rate: 118.75 });
  await searchFor(page, `PO-${c}`);
  expect(sql(`select count(*) from procurement.purchase_order where po_number='PO-${c}'`)).toBe('1');
  // A decimal quantity and rate must survive the form: the browser used to refuse them (step defaults to 1).
  expect(sql(`select i.ordered_qty::numeric::text from procurement.purchase_order_items i join procurement.purchase_order o using (purchase_order_id) where o.po_number='PO-${c}'`)).toMatch(/^2\.50*$/);
  await page.reload();
  await expect(page.locator('#ra-title')).toHaveText('Purchase orders');
  await searchFor(page, `PO-${c}`);
});

test('receiving is refused a purchase order and a supplier', async ({ page }) => {
  await signIn(page, 'factory', 'receiving');
  await expect(page.locator('#ra-side .who small')).toHaveText('Receiving');
  await expectRefused(page, 'POST', '/v1/purchase-orders', { vendorId: '00000000-0000-0000-0000-000000000000', items: [] });
  await expectRefused(page, 'POST', '/v1/vendors', { vendorName: 'No' });
});
