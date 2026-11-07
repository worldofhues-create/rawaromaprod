/* SCAN-8: a kiosk tablet 1024 px or wider showed a blank screen. The kiosk lock hides the rail with
 * display:none, which takes it out of the grid; at >= 1024 the shell's grid is `0 1fr` (rail folded),
 * so the main column fell into the 0 px track. Tablets are often 1024+ wide (iPad landscape, 10"
 * Android). The station's screen must fill the width at every size. */
import { expect, test } from '@playwright/test';
import { signIn } from '../../harness/walk';

for (const w of [768, 1024, 1280, 1440]) {
  test(`kiosk ${w}px: the locked station screen fills the width and its controls are usable`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    await page.addInitScript(() => { try { localStorage.setItem('ra.kiosk', JSON.stringify({ station: 'Packing 1', screen: 'packing', deviceId: 'walk' })); } catch (e) { /* about:blank */ } });
    await signIn(page, 'factory', 'packing');
    await expect(page.locator('html')).toHaveClass(/ra-kiosk/);
    await expect(page.locator('#ra-view')).toContainText('Packing station');
    const box = (await page.locator('#ra-view').boundingBox())!;
    expect(box.width, 'view width').toBeGreaterThan(w * 0.6);
    await expect(page.locator('#fo-pk-so')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
}
