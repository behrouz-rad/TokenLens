import { expect, test } from '@playwright/test';
import { buildScenario, collectErrors, feedObservations, FIXED_NOW, openPanel, tokenItemNamed, tokenItems } from '../../support/panel';

test.describe('panel UI (built panel.html, real BroadcastChannel protocol)', () => {
  test('shows an informative empty state, dark theme and TokenLens branding', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page);
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByText('No tokens captured yet')).toBeVisible();
    await expect(page.getByText(/Authorization: Bearer header/)).toBeVisible();
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 0 tokens');
    await expect(page.getByTestId('status-filter-summary')).toHaveText('Showing all data');
    await expect(page.getByText('Select a token to view its payload')).toBeVisible();
    await expect(page).toHaveTitle('TokenLens');
    errors.assertClean();
  });

  test('captures tokens, deduplicates, correlates requests and renders every inspector section', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page);
    const { observations } = buildScenario();
    await feedObservations(page, observations);

    await expect(tokenItems(page)).toHaveCount(7);
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 8 tokens');
    await expect(page.getByTestId('status-request-count')).toHaveText('Requests with Bearer: 10');
    await expect(page.getByTestId('status-http-breakdown')).toContainText('2xx: 7');
    await expect(page.getByTestId('status-http-breakdown')).toContainText('4xx: 2');
    await expect(page.getByTestId('status-http-breakdown')).toContainText('5xx: 1');

    await feedObservations(page, observations);
    await expect(page.getByTestId('status-request-count')).toHaveText('Requests with Bearer: 10');

    await expect(page.getByTestId('token-header-name')).toHaveText('access_token');
    await expect(page.getByTestId('token-header')).toContainText('JWT (Access)');
    await expect(page.getByTestId('token-header')).toContainText('Signature present — not verified');
    await expect(page.getByTestId('token-header-preview')).toContainText('Bearer eyJhbGciOiJSUzI1…');

    const claims = page.getByTestId('claims-summary');
    await expect(claims).toContainText('iss');
    await expect(claims).toContainText('https://issuer.example.test');
    await claims.getByRole('button', { name: /Show all 7 claims/ }).click();
    await expect(claims).toContainText('{"id":"o-1","tags":["a","b"]}');

    const timeline = page.getByTestId('token-timeline');
    await expect(timeline.getByTestId('timeline-event')).toHaveCount(5);
    await expect(timeline).toContainText('GET /admin');
    await expect(timeline).toContainText('403');

    const table = page.getByTestId('request-table');
    await expect(table.getByTestId('request-row')).toHaveCount(3);
    await expect(table).toContainText('Used in requests (3)');
    await table.getByRole('button', { name: /Status/ }).click();
    const statuses = await table.getByTestId('request-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.status));
    expect(statuses).toEqual(['200', '201', '403']);

    const diagnostics = page.getByTestId('diagnostics-panel');
    await expect(diagnostics).toContainText('Signature present — not verified');
    await expect(diagnostics).toContainText('RS256 (asymmetric)');
    await expect(diagnostics).toContainText('Not expired');
    await expect(diagnostics).toContainText('Not measured');
    await expect(diagnostics).toContainText('e2e-key');
    await expect(diagnostics).not.toContainText('keys available');
    await expect(diagnostics).toContainText('1 request forbidden');

    const payload = page.getByTestId('payload-viewer');
    await expect(payload.getByTestId('json-viewer')).toContainText('"sub"');
    await expect(payload).toContainText('"tags"');
    await payload.getByRole('button', { name: 'Expand tags' }).click();
    await expect(payload).toContainText('"a"');
    await payload.getByRole('button', { name: 'Collapse org' }).click();
    await expect(payload).not.toContainText('"tags"');
    await payload.getByRole('button', { name: 'Expand all' }).click();
    await expect(payload).toContainText('"a"');
    await payload.getByRole('button', { name: 'Raw' }).click();
    await expect(payload.getByTestId('payload-raw')).toContainText('eyJhbGciOiJSUzI1NiIs');

    errors.assertClean();
  });

  test('handles opaque, malformed, unicode and no-expiry tokens without errors', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);

    await tokenItemNamed(page, 'bearer_token').click();
    await expect(page.getByTestId('non-jwt-notice')).toContainText('Bearer (opaque)');
    await expect(page.getByTestId('payload-viewer')).toContainText('Opaque Bearer token: no decodable payload');
    await expect(page.getByTestId('diagnostics-panel')).toContainText('Opaque Bearer token');
    await expect(page.getByTestId('request-table')).toContainText('Used in requests (1)');

    await tokenItemNamed(page, 'malformed_token').click();
    await expect(page.getByTestId('diagnostics-panel')).toContainText('Malformed JWT');
    await expect(page.getByTestId('token-header')).toContainText('Invalid');

    await tokenItemNamed(page, 'jwt_token').first().click();
    await page.getByRole('tab', { name: 'Claims' }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await page.getByRole('tab', { name: 'Overview' }).click();

    const noExpiry = tokenItemNamed(page, 'legacy.example.test');
    await noExpiry.click();
    await expect(page.getByTestId('token-header')).toContainText('No expiry');
    await expect(page.getByTestId('diagnostics-panel')).toContainText('No exp claim — lifetime unknown');

    await page.getByLabel('Filter tokens').fill('ünïcødé');
    await expect(tokenItems(page)).toHaveCount(1);
    await tokenItems(page).first().click();
    await page.getByRole('tab', { name: 'Payload' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Zoë 🔐 東京');
    await page.getByLabel('Filter tokens').fill('');
    errors.assertClean();
  });

  test('filters combine predictably and counts reflect visible results', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);

    await expect(page.getByRole('button', { name: /Show expired \(1\)/ })).toBeVisible();
    await page.getByRole('button', { name: 'Only expired' }).click();
    await expect(tokenItems(page)).toHaveCount(1);
    await expect(tokenItems(page).first()).toContainText('Expired');
    await expect(page.getByTestId('status-filter-summary')).toHaveText('Showing 1 of 8 tokens');
    await expect(page.getByTestId('token-list-heading')).toHaveText('Tokens (1/8)');

    await page.getByRole('button', { name: 'Used in failed requests' }).click();
    await expect(page.getByTestId('quick-filter-count-failed-requests')).toHaveText('3');
    await expect(tokenItems(page)).toHaveCount(2);
    await page.getByRole('button', { name: /Show expired \(1\)/ }).click();
    await expect(tokenItems(page)).toHaveCount(3);

    await page.getByLabel('Filter tokens').fill('old.example');
    await expect(tokenItems(page)).toHaveCount(1);
    await page.getByLabel('Filter tokens').fill('zzz-no-match');
    await expect(page.getByText('No tokens match the current filters')).toBeVisible();

    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const popover = page.getByTestId('filters-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('Showing 0 of 8 tokens');
    await popover.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByTestId('status-filter-summary')).toHaveText('Showing all data');
    await expect(tokenItems(page)).toHaveCount(8);
    await popover.getByLabel('Show expired tokens in list').uncheck();
    await expect(tokenItems(page)).toHaveCount(7);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
  });

  test('pause, resume and clear behave as documented', async ({ page }) => {
    await openPanel(page);
    const { observations } = buildScenario();
    await feedObservations(page, observations.slice(0, 2));
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 1 token');

    await page.getByRole('button', { name: /Recording/ }).click();
    await expect(page.getByTestId('status-paused')).toContainText('Paused');
    await feedObservations(page, observations.slice(2, 6));
    await expect(page.getByTestId('status-paused')).toContainText('4 skipped');
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 1 token');

    await page.getByRole('button', { name: /Paused/ }).click();
    await feedObservations(page, observations.slice(2, 6));
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 1 token');
    await feedObservations(page, observations.slice(6));
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 5 tokens');

    await page.getByRole('button', { name: 'Clear captured tokens and requests' }).click();
    await expect(page.getByText(/Cleared 5 tokens and 6 requests/)).toBeVisible();
    await expect(page.getByText('No tokens captured yet')).toBeVisible();
    await expect(page.getByTestId('status-request-count')).toHaveText('Requests with Bearer: 0');
  });

  test('copy actions are explicit and give feedback', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPanel(page);
    const { observations, tokens } = buildScenario();
    await feedObservations(page, observations);
    await page.getByRole('button', { name: 'Copy Bearer token' }).click();
    await expect(page.getByText('Authorization header copied to clipboard')).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(`Bearer ${tokens.access}`);

    await page.getByRole('button', { name: 'Copy payload JSON' }).click();
    await expect(page.getByText('Payload JSON copied')).toBeVisible();
    const payload = await page.evaluate(() => navigator.clipboard.readText());
    expect(payload).toContain('"sub": "user-1"');
    expect(payload).not.toContain(tokens.access);
  });

  test('expiry state advances with time without a reload', async ({ page }) => {
    await page.clock.install({ time: FIXED_NOW });
    await openPanel(page, { fixedTime: null });
    await feedObservations(page, buildScenario().observations);
    const expiring = tokenItemNamed(page, 'api.example.test/soon').or(tokenItems(page).filter({ hasText: 'Expiring' }).first());
    await expect(expiring).toContainText('Expiring');
    await expect(page.getByTestId('quick-filter-count-only-expired')).toHaveText('1');
    await page.clock.runFor(121_000);
    await expect(page.getByTestId('quick-filter-count-only-expired')).toHaveText('2');
    await expect(tokenItems(page).filter({ hasText: 'Expiring' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Show expired \(2\)/ })).toBeVisible();
  });

  test('only functional sections are offered and every toolbar control does something', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    const nav = page.getByRole('navigation', { name: 'Main sections' });
    await expect(nav.getByRole('button')).toHaveText(['Overview', 'Requests', 'Timeline']);
    await expect(page.getByText(/Coming soon/)).toHaveCount(0);
    await nav.getByRole('button', { name: 'Requests' }).click();
    await expect(page.getByTestId('requests-explorer')).toBeVisible();
    await nav.getByRole('button', { name: 'Timeline' }).click();
    await expect(page.getByTestId('global-timeline')).toBeVisible();
    await nav.getByRole('button', { name: 'Overview' }).click();
    await expect(page.getByTestId('token-header-name')).toHaveText('access_token');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Maximize payload panel' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Restore payload panel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    const timeline = page.getByTestId('token-timeline');
    await expect(timeline.getByRole('button', { name: /Show all/ })).toHaveCount(0);
    errors.assertClean();
  });
});
