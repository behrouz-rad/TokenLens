import { defineConfig, devices } from '@playwright/test';

const FIXTURE_PORT = Number(process.env.TOKENLENS_FIXTURE_PORT ?? 4173);
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

/**
 * Three deliberately separate test classes:
 *  - panel-ui:   the built panel.html opened as an ordinary page; exercises the React UI through the
 *                real BroadcastChannel protocol. Proves nothing about DevTools registration.
 *  - extension:  the unpacked extension loaded into a persistent Chromium context; proves the
 *                manifest, extension pages and runtime load without errors.
 *  - devtools:   a headed run that opens real Chrome DevTools, locates the TokenLens tab and drives
 *                it over the Chrome DevTools Protocol. Not part of the default CI gate.
 */
export default defineConfig({
  testDir: './e2e/tests',
  outputDir: './test-results',
  /**
   * Screenshot baselines are rendering-environment specific, so they are stored per platform:
   * `e2e/tests/__screenshots__/<platform>/<spec path>/<name>.png`. The `linux` set is what CI
   * compares against and is generated inside the same pinned Playwright image CI runs in
   * (`npm run test:e2e:baselines`); the `win32` set serves local Windows runs.
   */
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{testFilePath}/{arg}{ext}',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Baselines are rendered by the same pinned browser build per platform, so comparisons are
    // strict: no differing pixel is tolerated and the per-pixel colour threshold is tightened. A
    // ratio or pixel-count allowance was measured to let a recoloured toolbar label pass unnoticed.
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      threshold: 0.1,
      maxDiffPixels: 0,
    },
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }], ['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: FIXTURE_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
  },
  webServer: {
    command: 'node e2e/fixture/server.mjs',
    url: `${FIXTURE_ORIGIN}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { TOKENLENS_FIXTURE_PORT: String(FIXTURE_PORT) },
  },
  projects: [
    {
      name: 'panel-ui',
      testMatch: /panel\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
    },
    {
      name: 'extension',
      testMatch: /extension\/.*\.spec\.ts/,
    },
    {
      name: 'devtools',
      testMatch: /devtools\/.*\.spec\.ts/,
      timeout: 180_000,
    },
  ],
});
