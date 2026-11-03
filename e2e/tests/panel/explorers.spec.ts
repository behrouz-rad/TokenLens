import { expect, test, type Page } from '@playwright/test';
import { createSyntheticJwt, withBearer } from '@/core/testing/synthetic';
import type { CaptureObservation } from '@/core/capture/observation';
import { scanWcag } from '../../support/axe';
import { buildScenario, collectErrors, feedObservations, FIXED_NOW, openPanel } from '../../support/panel';

const seconds = (ms: number) => Math.floor(ms / 1000);
const nav = (page: Page, name: 'Overview' | 'Requests' | 'Timeline') => page.getByRole('navigation', { name: 'Main sections' }).getByRole('button', { name, exact: true });
const requestRows = (page: Page) => page.getByTestId('requests-explorer').getByTestId('request-row');
const timelineEvents = (page: Page) => page.getByTestId('global-timeline-event');
const statusesOf = (page: Page) => requestRows(page).evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.status));

test.describe('Requests explorer', () => {
  test('starts empty and fills with every captured request across tokens', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page);
    await nav(page, 'Requests').click();
    await expect(page.getByText('No requests captured yet')).toBeVisible();
    await expect(nav(page, 'Requests')).toHaveAttribute('aria-current', 'page');

    await feedObservations(page, buildScenario().observations);
    await expect(page.getByTestId('requests-heading')).toHaveText('Requests (10)');
    await expect(requestRows(page)).toHaveCount(10);
    expect(await statusesOf(page)).toEqual(['500', '200', '200', '200', '200', '401', '200', '403', '201', '200']);
    const first = requestRows(page).first();
    await expect(first).toContainText('api.example.test');
    await expect(first).toContainText('/broken');
    await expect(first).toContainText('malformed_token');
    errors.assertClean();
  });

  test('search, status and token filters combine and clear', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await nav(page, 'Requests').click();

    await page.getByRole('searchbox', { name: 'Search requests' }).fill('old.example');
    expect(await statusesOf(page)).toEqual(['401']);
    await page.getByRole('searchbox', { name: 'Search requests' }).fill('');

    const group = page.getByRole('group', { name: 'Filter by HTTP status' });
    await group.getByRole('button', { name: /^4xx/ }).click();
    expect(await statusesOf(page)).toEqual(['401', '403']);
    await expect(page.getByTestId('requests-heading')).toHaveText('Requests (2 of 10)');

    const select = page.getByRole('combobox', { name: 'Filter by token' });
    await select.selectOption({ label: 'access_token #1 · api.example.test' });
    expect(await statusesOf(page)).toEqual(['403']);
    await group.getByRole('button', { name: /^All/ }).click();
    expect(await statusesOf(page)).toEqual(['403', '201', '200']);

    await page.getByRole('searchbox', { name: 'Search requests' }).fill('zzz');
    await expect(page.getByText('No requests match the current filters')).toBeVisible();
    await page.getByRole('button', { name: 'Show all requests' }).click();
    await expect(requestRows(page)).toHaveCount(10);
  });

  test('sorts by time, status and duration', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await nav(page, 'Requests').click();
    const explorer = page.getByTestId('requests-explorer');
    await explorer.getByRole('button', { name: /Status/ }).click();
    expect(await statusesOf(page)).toEqual(['200', '200', '200', '200', '200', '200', '201', '401', '403', '500']);
    await explorer.getByRole('columnheader', { name: /Status/ }).and(page.locator('[aria-sort="ascending"]')).waitFor();
    await explorer.getByRole('button', { name: /Duration/ }).click();
    const durations = await requestRows(page).evaluateAll((rows) => rows.map((r) => r.children[4]?.textContent ?? ''));
    expect(durations.length).toBe(10);
    await explorer.getByRole('button', { name: /Time/ }).click();
    expect(await statusesOf(page)).toEqual(['200', '201', '403', '200', '401', '200', '200', '200', '200', '500']);
  });

  test('navigates to a token in Overview and works with the keyboard', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await nav(page, 'Requests').click();
    const button = requestRows(page).filter({ hasText: '/userinfo' }).getByRole('button', { name: /Show bearer_token #\d+ in Overview/ });
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(nav(page, 'Overview')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('token-header-name')).toHaveText('bearer_token');
  });

  test('stays consistent through pause, clear and eviction', async ({ page }) => {
    await openPanel(page, { fixedTime: null });
    const { observations } = buildScenario(Date.now());
    await feedObservations(page, observations.slice(0, 3));
    await nav(page, 'Requests').click();
    await expect(page.getByTestId('requests-heading')).toHaveText('Requests (3)');

    await page.getByRole('button', { name: /Recording/ }).click();
    await feedObservations(page, observations.slice(3, 6));
    await expect(page.getByTestId('status-paused')).toContainText('3 skipped');
    await expect(page.getByTestId('requests-heading')).toHaveText('Requests (3)');
    await page.getByRole('button', { name: /Paused/ }).click();
    await feedObservations(page, observations.slice(6));
    await expect(page.getByTestId('requests-heading')).toHaveText('Requests (7)');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Max requests').fill('100');
    await page.getByLabel('Max tokens').fill('10');
    await page.keyboard.press('Escape');
    const now = Date.now();
    const many: CaptureObservation[] = Array.from({ length: 300 }, (_, i) =>
      withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: `evict-${i % 40}`, exp: seconds(now) + 3600 }), { url: `https://api.example.test/e/${i}`, startedAt: now + i, seq: 1000 + i })
    );
    await feedObservations(page, many);
    // Token eviction removes requests too, so the exact count depends on which tokens survived;
    // what must hold is that the explorer, the status bar and the limits agree.
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 10 tokens');
    await expect(page.getByText(/Evicted: [1-9]\d* tokens/)).toBeVisible();
    const remaining = Number((await page.getByTestId('status-request-count').textContent())?.match(/\d+$/)?.[0]);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(100);
    await expect(page.getByTestId('requests-heading')).toHaveText(`Requests (${remaining})`);
    const tokenRefs = await requestRows(page).evaluateAll((rows) => rows.map((r) => r.textContent?.includes('evicted') ?? false));
    expect(tokenRefs.some(Boolean)).toBe(false);

    await page.getByRole('button', { name: 'Clear captured tokens and requests' }).click();
    await expect(page.getByText('No requests captured yet')).toBeVisible();
  });

  test('renders thousands of requests with a bounded DOM', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page, { fixedTime: null });
    const now = Date.now();
    const tokens = Array.from({ length: 50 }, (_, i) => createSyntheticJwt({ alg: 'HS256' }, { sub: `bulk-${i}`, exp: seconds(now) + 3600 }));
    const batch: CaptureObservation[] = Array.from({ length: 3000 }, (_, i) =>
      withBearer(tokens[i % tokens.length]!, { url: `https://api.example.test/bulk/${i}`, status: i % 10 === 0 ? 500 : 200, startedAt: now + i })
    );
    for (let i = 0; i < batch.length; i += 500) await feedObservations(page, batch.slice(i, i + 500));
    await nav(page, 'Requests').click();
    await expect(page.getByTestId('requests-heading')).toHaveText('Requests (3000)');
    expect(await requestRows(page).count()).toBeLessThan(80);
    await page.getByRole('group', { name: 'Filter by HTTP status' }).getByRole('button', { name: /^5xx/ }).click();
    await expect(page.getByTestId('requests-heading')).toHaveText('Requests (300 of 3000)');
    await page.locator('[aria-label="Captured requests (scrollable)"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(requestRows(page).last()).toContainText('/bulk/0');
    await nav(page, 'Timeline').click();
    await expect(page.getByTestId('timeline-heading')).toHaveText('Timeline (3050 events)');
    expect(await timelineEvents(page).count()).toBeLessThan(80);
    errors.assertClean();
  });
});

test.describe('global Timeline', () => {
  test('shows observed and claim-derived events across tokens with filters and navigation', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page);
    await nav(page, 'Timeline').click();
    await expect(page.getByText('No events yet')).toBeVisible();

    await feedObservations(page, buildScenario().observations);
    await expect(page.getByTestId('timeline-heading')).toContainText('events');
    const count = await timelineEvents(page).count();
    expect(count).toBeGreaterThan(10);
    await expect(page.getByText(/Observed.*events come from captured traffic/)).toBeVisible();
    await expect(page.locator('[data-testid="global-timeline-event"][data-basis="claim"]').first()).toBeVisible();
    await expect(page.getByTestId('global-timeline')).not.toContainText(/refresh/i);

    const group = page.getByRole('group', { name: 'Filter by event type' });
    await group.getByRole('button', { name: /^Failed request/ }).click();
    await expect(timelineEvents(page)).toHaveCount(3);
    await page.getByRole('combobox', { name: 'Filter by token' }).selectOption({ label: 'access_token #1 · api.example.test' });
    await expect(timelineEvents(page)).toHaveCount(1);
    await expect(timelineEvents(page).first()).toContainText('/admin');

    await timelineEvents(page).first().getByRole('button', { name: /Show request/ }).click();
    await expect(nav(page, 'Requests')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-testid="request-row"][data-focused]')).toContainText('/admin');

    await nav(page, 'Timeline').click();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(timelineEvents(page)).toHaveCount(count);
    await timelineEvents(page).filter({ hasText: 'First observed' }).first().getByRole('button', { name: /in Overview/ }).click();
    await expect(nav(page, 'Overview')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('token-header')).toBeVisible();
    errors.assertClean();
  });

  test('records expiry transitions as claim-derived events as time advances', async ({ page }) => {
    await page.clock.install({ time: FIXED_NOW });
    await openPanel(page, { fixedTime: null });
    await feedObservations(page, buildScenario().observations);
    await nav(page, 'Timeline').click();
    const expiredBefore = await page.locator('[data-event-type="expired"]').count();
    await page.clock.runFor(121_000);
    await expect(page.locator('[data-event-type="expired"]')).toHaveCount(expiredBefore + 1);
    await expect(page.locator('[data-event-type="expired"]').first()).toHaveAttribute('data-basis', 'claim');
  });

  test('stays usable in a narrow viewport and after clearing', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 520, height: 700 });
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await nav(page, 'Timeline').click();
    await expect(timelineEvents(page).first()).toBeVisible();
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await nav(page, 'Requests').click();
    await expect(requestRows(page).first()).toBeVisible();
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Clear captured tokens and requests' }).click();
    await expect(page.getByText('No requests captured yet')).toBeVisible();
    await nav(page, 'Timeline').click();
    await expect(page.getByText('No events yet')).toBeVisible();
    errors.assertClean();
  });

  test('the toolbar Filters control belongs to the Overview and the status bar follows the active section', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    const filters = page.getByRole('button', { name: 'Filters', exact: true });
    const summary = page.getByTestId('status-filter-summary');

    await expect(filters).toBeVisible();
    await page.getByRole('button', { name: 'Only expired' }).click();
    await expect(summary).toHaveText('Showing 1 of 8 tokens');
    await expect(filters).toHaveAttribute('aria-pressed', 'true');

    await nav(page, 'Requests').click();
    await expect(filters).toHaveCount(0);
    await expect(page.getByTestId('requests-heading')).toHaveText('Requests (10)');
    await expect(summary).toHaveText('Showing all data');
    await page.getByRole('group', { name: 'Filter by HTTP status' }).getByRole('button', { name: /^4xx/ }).click();
    await expect(summary).toHaveText('Showing 2 of 10 requests');

    await nav(page, 'Timeline').click();
    await expect(filters).toHaveCount(0);
    await expect(summary).toHaveText('Showing all data');
    await page.getByRole('group', { name: 'Filter by event type' }).getByRole('button', { name: /^Failed request/ }).click();
    await expect(summary).toHaveText(/^Showing 3 of \d+ events$/);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(summary).toHaveText('Showing all data');

    // Keyboard: the Filters control is reachable again in the Overview and still reflects the token filter.
    await nav(page, 'Overview').click();
    await expect(filters).toBeVisible();
    await expect(filters).toHaveAttribute('aria-pressed', 'true');
    await expect(summary).toHaveText('Showing 1 of 8 tokens');
    await filters.focus();
    await page.keyboard.press('Enter');
    const popover = page.getByTestId('filters-popover');
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: 'Clear filters' }).click();
    await expect(summary).toHaveText('Showing all data');
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(filters).toBeFocused();
    errors.assertClean();
  });

  test('both explorers pass WCAG A/AA in dark and light themes', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    for (const theme of ['dark', 'light'] as const) {
      if (theme === 'light') {
        await page.getByRole('button', { name: 'Switch to light theme' }).click();
        await expect(page.locator('html')).toHaveClass(/light/);
      }
      await nav(page, 'Requests').click();
      await expect(requestRows(page).first()).toBeVisible();
      expect(await scanWcag(page), `requests ${theme}`).toEqual([]);
      await nav(page, 'Timeline').click();
      await expect(timelineEvents(page).first()).toBeVisible();
      expect(await scanWcag(page), `timeline ${theme}`).toEqual([]);
    }
  });
});
