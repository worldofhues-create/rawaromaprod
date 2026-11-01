/* Platform: connectors. The bridge config row, read from the console. */
import { expect, test } from '@playwright/test';
import { bridge, rp } from '../../harness/chain';
import { platformGo, signIn, sql } from '../../harness/walk';

test('the configured bridge connector shows, its secret does not; filling is refused', async ({ page }) => {
  await bridge();
  expect(sql('select count(*) from bridge.connector_config')).not.toBe('0');
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/connectors', 'Connectors');
  await expect(page.locator('tbody tr').first()).toContainText('Set');
  await expect(page.locator('body')).not.toContainText('browser-suite-bridge-secret');
  expect((await rp('filling', 'GET', '/v1/platform/providers')).status).toBe(403);
});
