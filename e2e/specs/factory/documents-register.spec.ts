/* Factory: documents register and house print format. */
import { expect, test } from '@playwright/test';
import { createViaForm, expectRefused, expectRowPersisted, openNav, signIn, sql, uniq } from '../../harness/walk';

test('owner registers a document; it reads back; the house format script is loaded', async ({ page }, info) => {
  const c = uniq('DOC', info);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Documents');
  await createViaForm(page, { title: `Walk ${c}`, documentType: 'Contract', referenceNo: c });
  await expectRowPersisted(page, `Walk ${c}`, () => sql(`select count(*) from platform.document_registry where title='Walk ${c}'`), 'Documents');
  const hasFormat = await page.evaluate(() => typeof (window as any).RaDocFormat !== 'undefined');
  expect(hasFormat, 'web/doc-format.js is on the page').toBe(true);
});

test('filling is refused the register', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'POST', '/v1/document-registry', { title: 'No', documentType: 'Contract' });
});
