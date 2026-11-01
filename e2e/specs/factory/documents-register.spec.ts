/* Factory: documents register and house print format. */
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { createViaForm, expectRefused, expectRowPersisted, openNav, rowAction, searchFor, signIn, sql, uniq } from '../../harness/walk';

test('owner registers a document; it reads back; the house format script is loaded', async ({ page }, info) => {
  const c = uniq('DOC', info);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Documents');
  await createViaForm(page, { title: `Walk ${c}`, documentType: 'Contract', referenceNo: c });
  await expectRowPersisted(page, `Walk ${c}`, () => sql(`select count(*) from platform.document_registry where title='Walk ${c}'`), 'Documents');
  // The printed output, as a PDF from the print window, read back as text. Chromium prints PDF only headless.
  await searchFor(page, `Walk ${c}`);
  const [popup] = await Promise.all([page.waitForEvent('popup'), rowAction(page, `Walk ${c}`, 'Print')]);
  await popup.waitForLoadState();
  await expect(popup.locator('body')).toContainText(`Walk ${c}`);
  const file = info.outputPath('doc.pdf');
  await popup.pdf({ path: file });
  const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  expect(text).toContain(`Walk ${c}`);
  expect(text).toContain('Raw Aromachem'); // letterhead
  expect(text).toContain('rawaromachem@gmail.com');
  expect(text, 'no field printed for a value nobody holds').not.toMatch(/undefined|null/);
});

test('filling is refused the register', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'POST', '/v1/document-registry', { title: 'No', documentType: 'Contract' });
});
