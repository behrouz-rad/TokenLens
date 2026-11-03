import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildScenario, collectErrors, feedObservations, openPanel, tokenItems } from '../../support/panel';

test.describe('theme and layout', () => {
  test('dark is the default, light can be chosen, and the preference survives a reload', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('html')).toHaveClass(/dark/);
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveClass(/light/);
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(lightBg).not.toBe(darkBg);

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/light/);
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('the toolbar shows the manifest version', async ({ page }) => {
    const { version } = JSON.parse(await readFile(resolve(process.cwd(), 'manifest.json'), 'utf8')) as { version: string };
    await openPanel(page);
    await expect(page.getByTestId('app-version')).toHaveText(`v${version}`);
  });

  test('visual baseline: populated overview, requests and timeline in dark and light', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    const nav = page.getByRole('navigation', { name: 'Main sections' });
    // The version badge changes with every release; masking it keeps the baselines release-independent
    // while every other pixel stays strictly compared. Its text is asserted by the test above.
    const screenshot = { fullPage: true, mask: [page.getByTestId('app-version')] };
    for (const theme of ['dark', 'light'] as const) {
      if (theme === 'light') {
        await page.getByRole('button', { name: 'Switch to light theme' }).click();
        await expect(page.locator('html')).toHaveClass(/light/);
      }
      await nav.getByRole('button', { name: 'Overview' }).click();
      await expect(page.getByTestId('token-header-name')).toHaveText('access_token');
      await expect(page).toHaveScreenshot(`overview-${theme}.png`, screenshot);
      await nav.getByRole('button', { name: 'Requests' }).click();
      await expect(page.getByTestId('requests-explorer').getByTestId('request-row')).toHaveCount(10);
      await expect(page).toHaveScreenshot(`requests-${theme}.png`, screenshot);
      await nav.getByRole('button', { name: 'Timeline' }).click();
      await expect(page.getByTestId('global-timeline-event').first()).toBeVisible();
      await expect(page).toHaveScreenshot(`timeline-${theme}.png`, screenshot);
    }
  });

  test('panels resize with the separators and the layout persists', async ({ page }) => {
    await openPanel(page);
    const sidebar = page.locator('[data-panel]#sidebar, [data-panel][id="sidebar"]').first();
    const before = (await sidebar.boundingBox())!.width;
    const separator = page.getByRole('separator', { name: 'Resize token list' });
    const box = (await separator.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = (await sidebar.boundingBox())!.width;
    expect(after).toBeGreaterThan(before + 60);

    await page.reload();
    const persisted = (await page.locator('[data-panel][id="sidebar"]').first().boundingBox())!.width;
    expect(Math.abs(persisted - after)).toBeLessThan(8);
  });

  test('narrow viewports switch to a single-column layout that stays usable', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 520, height: 700 });
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await expect(page.getByTestId('narrow-layout')).toBeVisible();
    await expect(tokenItems(page).first()).toBeVisible();
    await tokenItems(page).nth(1).click();
    await expect(page.getByTestId('token-header')).toBeVisible();
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await expect(page.getByTestId('payload-viewer')).toBeVisible();
    await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1200, height: 700 });
    await expect(page.getByTestId('narrow-layout')).toBeHidden();
    await expect(page.getByTestId('inspector-column')).toBeVisible();
    errors.assertClean();
  });

  test('long claim values and URLs wrap or truncate without horizontal page overflow', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await tokenItems(page).filter({ hasText: 'very.long.example.test' }).first().click();
    await expect(page.getByTestId('token-header')).toContainText('x'.repeat(20));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const header = page.getByTestId('token-header');
    const headerBox = (await header.boundingBox())!;
    const bodyWidth = await page.evaluate(() => document.body.clientWidth);
    expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(bodyWidth + 1);
  });

  test('scrollable regions scroll independently', async ({ page }) => {
    await openPanel(page);
    const { observations } = buildScenario();
    // Sequence numbers must exceed everything already fed to this relay id, or the store treats them as replays.
    const maxSeq = Math.max(...observations.map((o) => o.seq));
    const many = Array.from({ length: 60 }, (_, i) => ({ ...observations[0]!, seq: maxSeq + 1 + i, url: `https://api.example.test/r/${i}` }));
    await feedObservations(page, [...observations, ...many]);
    await page.getByTestId('request-table').getByRole('button', { name: /Show all 63 requests/ }).click();
    const scrollable = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>('.overflow-auto')];
      return nodes.filter((n) => n.scrollHeight > n.clientHeight + 2).length;
    });
    expect(scrollable).toBeGreaterThanOrEqual(1);
    const pageScroll = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
    expect(pageScroll).toBeLessThanOrEqual(0);
  });
});
