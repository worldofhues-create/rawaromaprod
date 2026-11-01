/* Factory: setup and master data. Physical layout entered by hand, one level at a time. */
import { expect, test } from '@playwright/test';
import { formula } from '../../harness/chain';
import { factoryCall, createViaForm, expectRefused, expectRowPersisted, openNav, signIn, sql, uniq } from '../../harness/walk';

test('warehouse builds a warehouse, floor, zone and rack; each reads back', async ({ page }, info) => {
  const c = uniq('S', info);
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Warehouses');
  await createViaForm(page, { warehouseCode: `WH${c}`, warehouseName: `Walk ${c}` });
  await expectRowPersisted(page, `WH${c}`, () => sql(`select count(*) from location.warehouse_master where warehouse_code='WH${c}'`), 'Warehouses');
  await openNav(page, 'Floors');
  await createViaForm(page, { floorCode: `FL${c}`, floorName: `Floor ${c}`, warehouseId: { label: `Walk ${c}` } });
  await expect(page.locator('#ra-results')).toContainText(`FL${c}`);
  await openNav(page, 'Zones');
  await createViaForm(page, { zoneCode: `ZN${c}`, zoneName: `Zone ${c}`, floorId: { label: `Floor ${c}` } });
  await expect(page.locator('#ra-results')).toContainText(`ZN${c}`);
  await openNav(page, 'Racks');
  await createViaForm(page, { rackCode: `RK${c}`, rackName: `Rack ${c}`, zoneId: { label: `Zone ${c}` } });
  await expectRowPersisted(page, `RK${c}`, () => sql(`select count(*) from location.rack_master where rack_code='RK${c}'`), 'Racks');
});

test('owner adds a material with its master data; the setup screen opens', async ({ page }, info) => {
  const c = uniq('M', info);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Material types');
  await createViaForm(page, { typeCode: `T${c}`, typeName: `Type ${c}` });
  await openNav(page, 'Materials');
  await createViaForm(page, { materialCode: `RM${c}`, materialName: `Material ${c}`, materialTypeId: { label: `Type ${c}` } });
  await expectRowPersisted(page, `RM${c}`, () => sql(`select count(*) from masterdata.material where material_code='RM${c}'`), 'Materials');
  await openNav(page, 'Factory setup');
  await expect(page.locator('#ra-view')).not.toContainText('not available');
});

test('sales is refused the physical layout and the material master', async ({ page }) => {
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/warehouses', { warehouseCode: 'NO', warehouseName: 'No' });
  await expectRefused(page, 'POST', '/v1/materials', { materialCode: 'NO', materialName: 'No' });
});

test('admin adds an organization and a business unit under it: one table, so the foreign key holds', async ({ page }, info) => {
  const c = uniq('O', info);
  await signIn(page, 'factory', 'admin');
  await openNav(page, 'Organizations');
  await createViaForm(page, { organizationCode: `ORG${c}`, organizationName: `Org ${c}` });
  await expectRowPersisted(page, `ORG${c}`, () => sql(`select count(*) from iam.org_master where organization_code='ORG${c}'`), 'Organizations');
  await openNav(page, 'Business units');
  await createViaForm(page, { businessUnitCode: `BU${c}`, businessUnitName: `Unit ${c}`, organizationId: { label: `Org ${c}` } });
  await expectRowPersisted(page, `BU${c}`, () => sql(`select count(*) from iam.business_unit_master where business_unit_code='BU${c}'`), 'Business units');
});

test('the Product form lists formulas from the main box directory, no recipe content; a floor role is refused', async ({ page }) => {
  await formula();
  await signIn(page, 'factory', 'packaging');
  await openNav(page, 'Products');
  await page.locator('#ra-new').click();
  await expect(page.locator('[data-name="formulaId"] option', { hasText: 'CH-F-1' })).toBeAttached();
  const r = await factoryCall(page, 'GET', '/v1/formulas?limit=5');
  expect(JSON.stringify(r.json.data)).not.toMatch(/percentage|Chain raw material/);
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveCount(1);
  await expectRefused(page, 'GET', '/v1/formulas?limit=5');
});
