import { expect, test } from '@playwright/test';
import { createSyntheticJwt, withBearer } from '@/core/testing/synthetic';
import type { CaptureObservation } from '@/core/capture/observation';
import { buildScenario, collectErrors, feedObservations, openPanel, tokenItems } from '../../support/panel';

const seconds = (ms: number) => Math.floor(ms / 1000);

test.describe('reliability and performance', () => {
  test('ingests a high-frequency burst of thousands of requests and stays responsive', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page, { fixedTime: null });
    const now = Date.now();
    const tokens = Array.from({ length: 300 }, (_, i) => createSyntheticJwt({ alg: 'HS256' }, { sub: `bulk-${i}`, exp: seconds(now) + 3600 + i }));
    const batch: CaptureObservation[] = Array.from({ length: 4000 }, (_, i) =>
      withBearer(tokens[i % tokens.length]!, { url: `https://api.example.test/bulk/${i}`, status: i % 11 === 0 ? 401 : 200, startedAt: now + i })
    );

    const started = Date.now();
    for (let i = 0; i < batch.length; i += 250) await feedObservations(page, batch.slice(i, i + 250));
    await expect(page.getByTestId('status-request-count')).toHaveText('Requests with Bearer: 4000', { timeout: 30_000 });
    const elapsedMs = Date.now() - started;
    test.info().annotations.push({ type: 'performance', description: `4000 observations across 300 tokens ingested and rendered in ${elapsedMs} ms (includes 16 evaluate round-trips)` });

    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 300 tokens');
    const renderedRows = await tokenItems(page).count();
    expect(renderedRows).toBeLessThan(80);

    const t0 = Date.now();
    await tokenItems(page).nth(3).click();
    await expect(page.getByTestId('token-header')).toBeVisible();
    expect(Date.now() - t0).toBeLessThan(2000);
    await page.getByLabel('Filter tokens').fill('bulk-29');
    await expect(tokenItems(page)).toHaveCount(11);
    errors.assertClean();
  });

  test('eviction keeps the session bounded and consistent', async ({ page }) => {
    await openPanel(page, { fixedTime: null });
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Max requests').fill('500');
    await page.getByLabel('Max tokens').fill('50');
    await page.keyboard.press('Escape');
    const now = Date.now();
    const batch: CaptureObservation[] = Array.from({ length: 1200 }, (_, i) =>
      withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: `evict-${i % 80}` }), { url: `https://api.example.test/e/${i}`, startedAt: now + i })
    );
    for (let i = 0; i < batch.length; i += 300) await feedObservations(page, batch.slice(i, i + 300));
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 50 tokens');
    await expect(page.getByTestId('status-request-count')).toContainText(/Requests with Bearer: ([1-4]\d\d|500)$/);
    // 80 tokens rotate through a 50-token cap, so evicted tokens legitimately reappear as new records.
    await expect(page.getByText(/Evicted: [1-9]\d* tokens/)).toBeVisible();
    await tokenItems(page).first().click();
    await expect(page.getByTestId('request-table')).toContainText(/Used in requests \([1-9]\d*\)/);
    const integrity = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid=request-row]')].length;
      return { rows };
    });
    expect(integrity.rows).toBeGreaterThan(0);
  });

  test('no duplicate processing when the same observations arrive again after a reload', async ({ page }) => {
    await openPanel(page);
    const { observations } = buildScenario();
    await feedObservations(page, observations);
    await expect(page.getByTestId('status-request-count')).toHaveText('Requests with Bearer: 10');
    await feedObservations(page, observations.slice(3));
    await feedObservations(page, observations);
    await expect(page.getByTestId('status-request-count')).toHaveText('Requests with Bearer: 10');
    await page.reload();
    await expect(page.getByText('No tokens captured yet')).toBeVisible();
  });

  test('all extension assets load and no uncaught errors occur during a full interaction pass', async ({ page }) => {
    const failed: string[] = [];
    page.on('requestfailed', (request) => failed.push(request.url()));
    page.on('response', (response) => {
      if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
    });
    const errors = collectErrors(page);
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    for (const tab of ['Payload', 'Header', 'Claims', 'Scopes', 'Raw', 'Overview']) {
      await page.getByRole('tab', { name: tab }).click();
    }
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    expect(failed).toEqual([]);
    errors.assertClean();
  });
});
