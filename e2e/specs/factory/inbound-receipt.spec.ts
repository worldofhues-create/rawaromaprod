/* Factory: vendor dispatch, gate entry, goods receipt. */
import { expect, test } from '@playwright/test';
import { issuedPo, master } from '../../harness/chain';
import { createDoc, createViaForm, expectRefused, expectRowPersisted, openNav, searchFor, signIn, sql, uniq } from '../../harness/walk';

test('supplier shipment, gate entry and GRN from an issued PO; the lot lands in quarantine', async ({ page }, info) => {
  const c = uniq('G', info);
  const { number } = await issuedPo(10);
  await signIn(page, 'factory', 'receiving');
  await openNav(page, 'Supplier shipments');
  await createViaForm(page, { purchaseOrderId: { label: number }, dispatchDate: '2031-05-01', transporter: `T-${c}`, docketNumber: `DK-${c}`, vehicleNumber: 'MP09AB1234' });
  await expectRowPersisted(page, `DK-${c}`, () => sql(`select count(*) from procurement.vendor_dispatch where docket_number='DK-${c}'`), 'Supplier shipments');

  await openNav(page, 'Gate entries');
  await createViaForm(page, { gateEntryNumber: `GE-${c}`, vendorId: { label: 'Chain Aromatics (test)' }, purchaseOrderId: { label: number }, vehicleNumber: 'MP09AB1234', driverName: 'Walk Driver', invoiceNumber: `INV-${c}` });
  await expectRowPersisted(page, `GE-${c}`, () => sql(`select count(*) from inventory.gate_entry_master where gate_entry_number='GE-${c}'`), 'Gate entries');

  await openNav(page, 'Goods receipts');
  await createDoc(page, { grnNumber: `GRN-${c}`, purchaseOrderId: { label: number }, gateEntryId: { label: `GE-${c}` }, grnDate: '2031-05-02' },
    { purchaseOrderItemId: { first: true }, materialId: { label: 'Chain raw material' }, receivedQty: 10, uomId: { label: 'CH-KG' } });
  await searchFor(page, `GRN-${c}`);
  expect(sql(`select count(*) from inventory.grn_master where grn_number='GRN-${c}'`)).toBe('1');
  await expect.poll(() => sql(`select b.status from inventory.rm_batch_master b join inventory.grn_items i on i.grn_item_id=b.grn_item_id join inventory.grn_master g on g.grn_id=i.grn_id where g.grn_number='GRN-${c}'`)).toBe('QUARANTINE');
});

test('sales is refused a gate entry and a goods receipt', async ({ page }) => {
  await master();
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/gate-entries', { vehicleNumber: 'NO' });
  await expectRefused(page, 'POST', '/v1/grns', { items: [] });
});
