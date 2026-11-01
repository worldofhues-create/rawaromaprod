/* Vault: approve recipes to Factory. */
import { expect, test } from '@playwright/test';
import { master, must, rp, until } from '../../harness/chain';
import { vaultGo, signIn, sql, uniq } from '../../harness/walk';

test('the approver ticks a waiting recipe and approves it; a formulator may not', async ({ page }, info) => {
  const { mat } = await master();
  const code = uniq('F-RV-', info);
  const f = await must('formulator', 'POST', '/v1/formulas', { formulaCode: code, formulaName: `Rev ${code}` }, { vault: true });
  const fv = (await must('formulator', 'POST', '/v1/formula-versions', { formulaId: f.formulaId, versionNumber: 1 }, { vault: true })).formulaVersionId;
  await until('catalogue sync', async () => (await rp('formulator', 'POST', `/v1/formula-versions/${fv}/ingredients`, { ingredients: [{ materialId: mat, percentage: 100, sequenceNo: 1 }] }, { vault: true })).status === 201);
  await must('formulator', 'POST', `/v1/formula-versions/${fv}/submit-for-review`, {}, { vault: true });
  expect((await rp('formulator', 'POST', '/v1/formula-versions/approve-batch', { versionIds: [fv] }, { vault: true })).status).toBe(403);

  await signIn(page, 'vault', 'vault_approver');
  await vaultGo(page, '#/review', 'Approve recipes');
  const row = page.locator('tr').filter({ hasText: code });
  await row.locator('input[type="checkbox"]').check();
  await page.locator('#review-approve').click();
  await page.getByRole('button', { name: /^Approve/ }).last().click();
  await expect.poll(() => sql(`select status from formula.formula_version where formula_version_id='${fv}'`, 'vault'), { timeout: 20_000 }).toMatch(/APPROVED|LOCKED/);
  expect(sql(`select count(*) from formula.formula_approval where formula_version_id='${fv}'`, 'vault')).not.toBe('0');
});
