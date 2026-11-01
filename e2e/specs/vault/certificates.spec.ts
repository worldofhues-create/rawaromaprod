/* Vault: certificates and result to sales. PARTIAL: the screen and the refusal only. A certificate needs real
 * IFRA data per material; this suite will not invent a regulatory fact to make one appear. */
import { expect, test } from '@playwright/test';
import { formula, rp } from '../../harness/chain';
import { signIn, vaultGo } from '../../harness/walk';

test('the approver sees the formula on Certificates with no certificate issued; filling is refused', async ({ page }) => {
  await formula();
  await signIn(page, 'vault', 'vault_approver');
  await vaultGo(page, '#/certificates', 'Certificates');
  await expect(page.locator('tbody')).toContainText('CH-F-1');
  expect((await rp('filling', 'GET', '/v1/compliance/status', undefined, { vault: true })).status).toBe(403);
});
