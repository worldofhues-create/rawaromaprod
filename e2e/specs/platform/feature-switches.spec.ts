/* Platform: feature switches. PARTIAL, see e2e/FINDINGS.md F7: a fresh system has no switch registered and no
 * screen or route registers one, so there is no row to change. This proves only the empty state and the refusal. */
import { expect, test } from '@playwright/test';
import { rp } from '../../harness/chain';
import { platformGo, signIn } from '../../harness/walk';

test('with no switch registered the screen says so; filling is refused a change', async ({ page }) => {
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/feature-switches', 'Feature switches');
  await expect(page.getByRole('heading', { name: 'No switches yet' })).toBeVisible();
  expect((await rp('filling', 'PUT', '/v1/admin/flags/anything', { env: 'staging', state: 'on', reason: 'nope' })).status).toBe(403);
});
