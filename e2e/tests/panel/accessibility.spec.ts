import { expect, test } from '@playwright/test';
import { scanWcag } from '../../support/axe';
import { buildScenario, feedObservations, openPanel, tokenItems } from '../../support/panel';

test.describe('accessibility', () => {
  test('empty state has no WCAG A/AA violations', async ({ page }) => {
    await openPanel(page);
    expect(await scanWcag(page)).toEqual([]);
  });

  test('populated overview has no WCAG A/AA violations in dark and light themes', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await expect(page.getByTestId('token-header-name')).toBeVisible();
    expect(await scanWcag(page)).toEqual([]);
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveClass(/light/);
    expect(await scanWcag(page)).toEqual([]);
  });

  test('popovers and dialog are accessible', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await expect(page.getByTestId('filters-popover')).toBeVisible();
    expect(await scanWcag(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Maximize payload panel' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await scanWcag(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('contrast is measured once transitions and animations have settled', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    await expect(page.getByTestId('token-header-name')).toBeVisible();
    // A tenfold slower animation clock makes every transition outlast the gap between an interaction
    // and the scan on any runner; without it only a fast runner lands inside that window, by chance.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveClass(/light/);
    expect(await scanWcag(page), 'colour transitions of the theme switch').toEqual([]);
    await page.getByRole('button', { name: 'Maximize payload panel' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await scanWcag(page), 'fade-in animation of the dialog').toEqual([]);
  });

  test('keyboard users can reach controls, move selection and see focus', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    const listbox = page.getByRole('listbox', { name: 'Captured tokens' });
    await tokenItems(page).first().click();
    await listbox.focus();
    const first = await tokenItems(page).first().getAttribute('data-token-id');
    await page.keyboard.press('ArrowDown');
    await expect(tokenItems(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(tokenItems(page).first()).toHaveAttribute('aria-selected', 'true');
    expect(await tokenItems(page).first().getAttribute('data-token-id')).toBe(first);

    await page.getByRole('button', { name: 'Filters', exact: true }).focus();
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, matches: el.matches(':focus-visible') };
    });
    expect(outline.matches).toBe(true);
    expect(outline.outlineStyle).not.toBe('none');
    expect(outline.outlineWidth).not.toBe('0px');

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('filters-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('filters-popover')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeFocused();
  });

  test('every icon-only button has an accessible name', async ({ page }) => {
    await openPanel(page);
    await feedObservations(page, buildScenario().observations);
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((b) => !(b.textContent ?? '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'))
        .map((b) => b.outerHTML.slice(0, 120))
    );
    expect(unnamed).toEqual([]);
  });
});
