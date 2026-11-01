/* Factory: hand-over from the staff strip. The RawProd half: ALEMBIC's token arrives in the fragment.
 * NOT WALKED HERE: ALEMBIC's own strip minting it (not in this stack; Alembic's open-handoff spec). */
import { expect, test } from '@playwright/test';
import { URLS } from '../../harness/config.mjs';
import { EMAIL, expectRefused, mintAssertion, openNav, signIn, sql } from '../../harness/walk';

test('a fresh token opens Factory, scrubs the address and writes a sign-in row the admin can read', async ({ page }) => {
  const before = Number(sql(`select count(*) from iam.login_history where email='${EMAIL.owner}'`));
  await signIn(page, 'factory', 'owner');
  await expect(page.locator('#ra-side .who small')).toHaveText('Owner');
  expect(page.url()).not.toContain('assertion');
  expect(Number(sql(`select count(*) from iam.login_history where email='${EMAIL.owner}'`))).toBeGreaterThan(before);
  await page.context().clearCookies();
  await signIn(page, 'factory', 'admin');
  await openNav(page, 'Sign-in history');
  await expect(page.locator('#ra-results')).toContainText(EMAIL.owner!);
});

test('a spent token is refused on the sign-in card', async ({ page }) => {
  const token = mintAssertion(EMAIL.owner!, 'factory');
  await page.goto(`${URLS.factory}/#assertion=${encodeURIComponent(token)}`);
  await expect(page.locator('#ra-side .who small')).toHaveText('Owner');
  await page.context().clearCookies();
  const fresh = await page.context().newPage();
  await fresh.goto(`${URLS.factory}/#assertion=${encodeURIComponent(token)}`);
  await expect(fresh.locator('#lerr')).toContainText('already been used');
});

test('a forged signature and an unknown person are refused', async ({ page }) => {
  const token = mintAssertion(EMAIL.owner!, 'factory');
  await page.goto(`${URLS.factory}/#assertion=${encodeURIComponent(`${token.slice(0, -6)}AAAAAA`)}`);
  await expect(page.locator('#lerr')).not.toBeEmpty();
  await expect(page.locator('#ra-side')).toHaveCount(0);
  const stranger = await page.context().newPage();
  await stranger.goto(`${URLS.factory}/#assertion=${encodeURIComponent(mintAssertion('nobody@rawaroma.local', 'factory'))}`);
  await expect(stranger.locator('#lerr')).toContainText('No RawProd account');
});

test('filling cannot read the sign-in history', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'GET', '/v1/login-history');
});
