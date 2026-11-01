/* Vault: formula and version lifecycle, author and approver separated. */
import { expect, test } from '@playwright/test';
import { master, rp } from '../../harness/chain';
import { signIn, sql, uniq } from '../../harness/walk';

test('author creates, seals and submits; the author cannot approve; the approver approves; filling is refused', async ({ page }, info) => {
  await master();
  const code = uniq('F-', info);
  await signIn(page, 'vault', 'formulator');
  await expect(page.locator('#vault-title')).toHaveText('Formulas');
  await page.getByRole('button', { name: /New formula/ }).click();
  await page.getByLabel('Formula code').fill(code);
  await page.getByLabel('Formula name').fill(`Walk ${code}`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from formula.formula_master where formula_code='${code}'`, 'vault')).toBe('1');
  const formulaId = sql(`select formula_id from formula.formula_master where formula_code='${code}'`, 'vault');
  await page.evaluate((id) => { location.hash = `#/formula/${id}`; }, formulaId);
  await page.getByRole('button', { name: /New version/ }).first().click();
  await expect.poll(() => sql(`select count(*) from formula.formula_version where formula_id='${formulaId}'`, 'vault')).toBe('1');
  const versionId = sql(`select formula_version_id from formula.formula_version where formula_id='${formulaId}'`, 'vault');
  await page.evaluate((id) => { location.hash = `#/version/${id}`; }, versionId);
  await page.getByRole('button', { name: 'Seal ingredient', exact: true }).click();
  await page.getByPlaceholder('Search material').fill('CH-RM-1');
  await page.getByLabel('Percentage').fill('100');
  await page.getByRole('button', { name: 'Seal', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from formula.formula_ingredients where formula_version_id='${versionId}'`, 'vault')).toBe('1');
  // Sealed means sealed: no plaintext in the row.
  expect(sql(`select count(*) from formula.formula_ingredients where formula_version_id='${versionId}' and row_to_json(formula_ingredients)::text like '%CH-RM-1%'`, 'vault')).toBe('0');
  await page.getByRole('button', { name: /Submit for review/ }).click();
  const send = page.getByRole('button', { name: /^(Submit|Submit for review|Send)$/ }).last();
  await send.click();
  await expect.poll(() => sql(`select status from formula.formula_version where formula_version_id='${versionId}'`, 'vault')).not.toBe('DRAFT');
  expect((await rp('formulator', 'POST', `/v1/formula-versions/${versionId}/approve`, {}, { vault: true })).status).toBe(403);
  await page.goto('about:blank');
  await signIn(page, 'vault', 'vault_approver');
  await expect(page.locator('#vault-title')).toHaveText('Formulas');
  await page.evaluate((id) => { location.hash = `#/version/${id}`; }, versionId);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).last().click();
  await expect.poll(() => sql(`select count(*) from formula.formula_approval where formula_version_id='${versionId}'`, 'vault')).not.toBe('0');
  expect((await rp('filling', 'GET', '/v1/formulas', undefined, { vault: true })).status).toBe(403);
});
