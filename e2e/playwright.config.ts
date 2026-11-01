import { defineConfig, devices } from '@playwright/test';

/* The real stack is stood up by `pnpm e2e:up`; global-setup refuses to run without it, so nothing can
 * pass against an empty box. One worker: the walks share one database and RAM is short. No retries: a
 * flaky walk is a finding. `forbidOnly` and no `test.skip` anywhere: a skip counts as not tested. */
export default defineConfig({
  testDir: './specs',
  globalSetup: './harness/global-setup.ts',
  outputDir: './.run/test-results',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: './.run/results.json' }]],
  use: { contextOptions: { reducedMotion: 'reduce' }, trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000 },
  projects: [
    { name: 'chromium-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'chromium-375', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 800 }, hasTouch: true } },
  ],
});
