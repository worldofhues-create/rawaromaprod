/* Factory: eleven role workspaces and access. Every role lands in its own workspace; one writes and
 * reads back; floor roles are refused by the server, not only by a hidden button. */
import { expect, test } from '@playwright/test';
import { createViaForm, factoryCall, expectNoNewButton, expectRefused, expectRowPersisted, openNav, signIn, sql, uniq } from '../../harness/walk';

const LANDINGS: Array<[string, string]> = [
  ['owner', 'Owner'], ['admin', 'Admin'], ['procurement', 'Procurement'], ['receiving', 'Receiving'], ['qc', 'QC Laboratory'], ['production', 'Production'],
  ['warehouse', 'Warehouse'], ['compounding', 'Compounding'], ['filling', 'Filling'], ['packaging', 'Packaging'], ['sales', 'Sales & Dispatch'],
];

for (const [role, label] of LANDINGS) {
  test(`${role} lands in the ${label} workspace`, async ({ page }) => {
    await signIn(page, 'factory', role);
    await expect(page.locator('#ra-side .who small')).toHaveText(label);
  });
}

test('owner adds a unit and it reads back after a reload', async ({ page }, info) => {
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Units');
  const code = uniq('U', info);
  await createViaForm(page, { uomCode: code, uomName: `Walk ${code}` });
  await expectRowPersisted(page, code, () => sql(`select count(*) from platform.uom_master where uom_code='${code}'`), 'Units');
});

test('compounding opens only its own screens and the server refuses it users and units', async ({ page }) => {
  await signIn(page, 'factory', 'compounding');
  await expect(page.locator('#ra-side .who small')).toHaveText('Compounding');
  await openNav(page, 'Production orders');
  await expectNoNewButton(page);
  await expectRefused(page, 'POST', '/v1/uoms', { uomCode: 'NOPE', uomName: 'No' });
  await expectRefused(page, 'GET', '/v1/users');
});

test('a floor role typing an address outside its workspace is told so', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await page.evaluate(() => { location.hash = '#/owner/users'; });
  await expect(page.getByText('That screen is not part of your workspace.')).toBeVisible();
  await expect(page.locator('#ra-title')).not.toHaveText('Users');
});

for (const role of ['receiving', 'packaging', 'compounding']) {
  test(`${role} may read units and may not write them`, async ({ page }) => {
    await signIn(page, 'factory', role);
    await expect(page.locator('#ra-side .who small')).toHaveCount(1);
    expect((await factoryCall(page, 'GET', '/v1/uoms?limit=1')).status).toBe(200);
    await expectRefused(page, 'POST', '/v1/uoms', { uomCode: 'NOPE', uomName: 'No' });
  });
}
test('filling still may not read units', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveCount(1);
  await expectRefused(page, 'GET', '/v1/uoms?limit=1');
});
