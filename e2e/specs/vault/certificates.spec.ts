/* Vault: certificates and result to sales. Every compliance row here is plainly TEST, with the source 'E2E TEST
 * FIXTURE', in the test database, written by this spec. Nothing ships in a seed, a migration or production code. */
import { expect, test } from '@playwright/test';
import { master, must, rp, until } from '../../harness/chain';
import { signIn, sql, uniq, vaultGo } from '../../harness/walk';

test('a TEST formula with complete TEST data gets a certificate on Recalculate, it reaches the main box; filling is refused', async ({ page }, info) => {
  const { kg } = await master();
  const c = uniq('', info);
  const mat = (await must('owner', 'POST', '/v1/materials', { materialCode: `TEST-RM-${c}`, materialName: `TEST material ${c}`, uomId: kg })).materialId;
  const f = await must('formulator', 'POST', '/v1/formulas', { formulaCode: `TEST-F-${c}`, formulaName: `TEST formula ${c}` }, { vault: true });
  const fv = (await must('formulator', 'POST', '/v1/formula-versions', { formulaId: f.formulaId, versionNumber: 1 }, { vault: true })).formulaVersionId;
  await until('catalogue sync', async () => (await rp('formulator', 'POST', `/v1/formula-versions/${fv}/ingredients`, { ingredients: [{ materialId: mat, percentage: 100, sequenceNo: 1 }] }, { vault: true })).status === 201);
  await must('formulator', 'POST', `/v1/formula-versions/${fv}/submit-for-review`, {}, { vault: true });
  await must('vault_approver', 'POST', `/v1/formula-versions/${fv}/approve`, { remarks: 'TEST' }, { vault: true });
  await must('vault_approver', 'POST', `/v1/formula-versions/${fv}/lock`, {}, { vault: true });
  await must('vault_approver', 'PUT', '/v1/compliance/settings', { ifraAmendment: 'TEST-AMENDMENT', reportingThresholdPct: 0.001, allergenListRef: 'TEST list' }, { vault: true });
  // The compliance route needs the material in the Vault's catalogue, which arrives on a timer.
  await until('the material in the Vault catalogue', async () => (await rp('vault_approver', 'PUT', `/v1/compliance/materials/${mat}`, { allergenComplete: true, ifraComplete: true, ifraAmendment: 'TEST-AMENDMENT', sourceRef: 'E2E TEST FIXTURE', allergens: [], ifra: [] }, { vault: true })).status < 300);

  await signIn(page, 'vault', 'vault_approver');
  await vaultGo(page, '#/certificates', 'Certificates');
  await page.getByRole('button', { name: 'Recalculate all', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from formula.compliance_certificate where formula_version_id='${fv}'`, 'vault'), { timeout: 30_000 }).not.toBe('0');
  await expect(page.locator('tr').filter({ hasText: `TEST-F-${c}` })).toBeVisible();
  await expect.poll(() => sql(`select count(*) from bridge.compliance_certificate where formula_id='${f.formulaId}'`), { timeout: 45_000 }).not.toBe('0');
  expect((await rp('filling', 'GET', '/v1/compliance/status', undefined, { vault: true })).status).toBe(403);
});
