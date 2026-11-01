/* Vault: open with a fresh code. A reload ends the session by design. */
import { expect, test } from '@playwright/test';
import { URLS } from '../../harness/config.mjs';
import { EMAIL, mintAssertion, signIn, sql } from '../../harness/walk';

test('a fresh step-up opens the Vault and leaves a VAULT_STEP_UP row; a reload ends it', async ({ page }) => {
  const q = `select count(*) from iam.login_history where email='${EMAIL.formulator}' and console='vault'`;
  const before = Number(sql(q));
  await signIn(page, 'vault', 'formulator');
  await expect(page.locator('#vault-title')).toHaveText('Formulas');
  expect(page.url()).not.toContain('assertion');
  expect(Number(sql(q))).toBeGreaterThan(before);
  await page.reload();
  await expect(page.locator('#vault-title')).toHaveCount(0);
  await expect(page.locator('#vault-ended')).toBeVisible();
});

test('a floor role with no formula permission is refused at the door, and a spent code cannot open it', async ({ page }) => {
  await signIn(page, 'vault', 'filling');
  await expect(page.locator('#vault-title')).toHaveCount(0);
  const token = mintAssertion(EMAIL.formulator!, 'vault');
  await page.goto('about:blank');
  await page.goto(`${URLS.vault}/#assertion=${encodeURIComponent(token)}`);
  await expect(page.locator('#vault-title')).toHaveText('Formulas');
  const again = await page.context().newPage();
  await again.goto(`${URLS.vault}/#assertion=${encodeURIComponent(token)}`);
  await expect(again.locator('#vault-title')).toHaveCount(0);
  await expect(again.getByText(/already been used/)).toBeVisible();
});
