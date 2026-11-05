import { defineConfig } from '@playwright/test';

const DEMO_PORT = Number(process.env.TOKENLENS_DEMO_PORT ?? 4180);

/**
 * Recorder for the promotional video: one headed run that films real Chrome DevTools with the
 * built extension (dist/). Kept apart from the repository's test projects on purpose; it asserts
 * that the story plays, it is not a quality gate. Run from the repository root:
 *   npx playwright test -c demo/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /record\.spec\.ts/,
  outputDir: './work/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: [['list']],
  use: { locale: 'en-US', timezoneId: 'UTC' },
  webServer: {
    command: 'node demo/fixture/server.mjs',
    cwd: '..',
    url: `http://127.0.0.1:${DEMO_PORT}/healthz`,
    reuseExistingServer: true,
    timeout: 30_000,
    env: { TOKENLENS_DEMO_PORT: String(DEMO_PORT) },
  },
});
