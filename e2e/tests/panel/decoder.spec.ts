import { expect, test, type Page } from '@playwright/test';
import { scanWcag } from '../../support/axe';
import { createSyntheticJwt } from '@/core/testing/synthetic';
import { buildScenario, collectErrors, feedObservations, FIXED_NOW, openPanel } from '../../support/panel';

const seconds = (ms: number) => Math.floor(ms / 1000);
const DECODER_JWT = createSyntheticJwt(
  { alg: 'RS256', typ: 'at+jwt', kid: 'decoder-key-1' },
  {
    iss: 'https://issuer.decoder.test',
    sub: 'decoder-user',
    aud: 'api://decoder',
    exp: seconds(FIXED_NOW) + 3600,
    iat: seconds(FIXED_NOW) - 120,
    nbf: seconds(FIXED_NOW) - 120,
    scope: 'read write',
    profile: { name: 'Zoë 🔐 東京', roles: ['viewer', 'editor'], prefs: { locale: 'de-DE', beta: true } },
  }
);
const MALFORMED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJicm9rZW4.!!!';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main sections' });
const field = (page: Page) => page.getByRole('textbox', { name: 'Token input' });
// The version badge changes with every release; see theme-layout.spec.ts.
const screenshotOptions = (page: Page) => ({ fullPage: true, mask: [page.getByTestId('app-version')] });

async function openDecoder(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: 'Decoder' }).click();
  await expect(page.getByTestId('decoder-workspace')).toBeVisible();
}

/** Pastes through the real clipboard and the browser's native paste, as a user would. */
async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await field(page).focus();
  await page.keyboard.press('ControlOrMeta+V');
}

async function decoded(page: Page): Promise<void> {
  await expect(page.getByTestId('decoder-output')).toHaveAttribute('data-stale', 'false');
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('Decoder', () => {
  test('acceptance: decode a pasted JWT with no capture, copy it, and switch sections without losing input', async ({ page }) => {
    const errors = collectErrors(page);
    await openPanel(page);
    await expect(page.getByText('No tokens captured yet')).toBeVisible();
    await openDecoder(page);
    await expect(page.getByText('Paste a JWT to inspect its header and payload.')).toBeVisible();
    await expect(page.getByText('Decoded locally. Signature not verified.')).toBeVisible();

    await paste(page, DECODER_JWT);
    await decoded(page);
    await expect(page.getByTestId('decoder-token-type')).toHaveText('JWT (Access)');
    await expect(page.getByTestId('decoder-facts')).toContainText('Signature present, not verified');
    await expect(page.getByTestId('decoded-payload')).toContainText('"Zoë 🔐 東京"');

    await page.getByTestId('decoded-header').getByRole('button', { name: 'Copy header JSON' }).click();
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual({ alg: 'RS256', typ: 'at+jwt', kid: 'decoder-key-1' });
    await page.getByTestId('decoded-payload').getByRole('button', { name: 'Copy payload JSON' }).click();
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject({ sub: 'decoder-user', profile: { roles: ['viewer', 'editor'] } });
    await page.getByRole('button', { name: 'Copy token' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(DECODER_JWT);

    await nav(page).getByRole('button', { name: 'Overview' }).click();
    await expect(page.getByText('No tokens captured yet')).toBeVisible();
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 0 tokens');
    await expect(page.getByTestId('status-request-count')).toHaveText('Requests with Bearer: 0');
    await nav(page).getByRole('button', { name: 'Timeline' }).click();
    await expect(page.getByTestId('timeline-heading')).toContainText('0 events');
    await openDecoder(page);
    await expect(field(page)).toHaveValue(DECODER_JWT);
    await expect(page.getByTestId('decoder-token-type')).toHaveText('JWT (Access)');
    errors.assertClean();
  });

  test('Pretty / Raw shows the exact encoded JSON and a Bearer prefix is accepted', async ({ page }) => {
    await openPanel(page);
    await openDecoder(page);
    await paste(page, `  Bearer ${DECODER_JWT}\n`);
    await decoded(page);
    await expect(page.getByTestId('decoder-hints')).toContainText('The Bearer prefix was ignored.');
    const payload = page.getByTestId('decoded-payload');
    await payload.getByRole('group', { name: 'Payload display mode' }).getByRole('button', { name: 'Raw' }).click();
    const rawText = await page.getByTestId('decoded-payload-raw').textContent();
    expect(rawText).toContain('"profile":{"name":"Zoë 🔐 東京"');
    await payload.getByRole('button', { name: 'Copy payload JSON' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rawText);
  });

  test('invalid input replaces a decoded result without leaving stale output', async ({ page }) => {
    await openPanel(page);
    await openDecoder(page);
    await paste(page, DECODER_JWT);
    await decoded(page);
    await field(page).fill(MALFORMED);
    await decoded(page);
    await expect(page.getByTestId('decoder-feedback')).toContainText('Malformed JWT');
    await expect(page.getByTestId('decoded-payload')).toHaveCount(0);
    await expect(page.getByTestId('decoder-token-type')).toHaveCount(0);
    await expect(page.getByTestId('status-decoder-state')).toHaveText('Malformed JWT');

    await page.getByRole('button', { name: 'Clear input' }).click();
    await expect(field(page)).toHaveValue('');
    await expect(page.getByText('Paste a JWT to inspect its header and payload.')).toBeVisible();
  });

  test('capture keeps running while the Decoder is open and the two never mix', async ({ page }) => {
    await openPanel(page);
    await openDecoder(page);
    await paste(page, DECODER_JWT);
    await decoded(page);
    await page.getByRole('button', { name: 'Recording' }).click();
    await page.getByRole('button', { name: 'Paused' }).click();
    await feedObservations(page, buildScenario().observations);
    await expect(field(page)).toHaveValue(DECODER_JWT);
    await page.getByRole('button', { name: 'Clear captured tokens and requests' }).click();
    await expect(field(page)).toHaveValue(DECODER_JWT);
    await feedObservations(page, buildScenario().observations.map((o) => ({ ...o, seq: o.seq + 1000 })));
    await nav(page).getByRole('button', { name: 'Overview' }).click();
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 8 tokens');
    await expect(page.getByTestId('token-item').filter({ hasText: 'decoder-user' })).toHaveCount(0);
  });

  test('decoding makes no network request and stores nothing', async ({ page }) => {
    await openPanel(page);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await openDecoder(page);
    await paste(page, `Bearer ${DECODER_JWT}`);
    await decoded(page);
    await page.getByRole('button', { name: 'Copy token' }).click();
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    expect(requests).toEqual([]);

    const stored = await page.evaluate(async () => ({
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
      databases: (await indexedDB.databases()).map((d) => d.name),
      cookie: document.cookie,
      url: location.href,
    }));
    const fragment = DECODER_JWT.slice(0, 24);
    for (const value of [stored.local, stored.session, stored.cookie, stored.url]) {
      expect(value).not.toContain(fragment);
      expect(value).not.toContain('decoder-user');
    }
    expect(stored.session).toBe('{}');
    expect(stored.databases).toEqual([]);
  });

  test('keyboard users can reach the Decoder and its controls', async ({ page }) => {
    await openPanel(page);
    await nav(page).getByRole('button', { name: 'Timeline' }).focus();
    await page.keyboard.press('Tab');
    await expect(nav(page).getByRole('button', { name: 'Decoder' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('decoder-workspace')).toBeVisible();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await field(page).evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'the token field is reachable with Tab').toBe(true);
    await page.keyboard.insertText(DECODER_JWT);
    await decoded(page);
    await expect(page.getByTestId('decoder-token-type')).toHaveText('JWT (Access)');
  });

  test('no WCAG A/AA violations: empty, decoded and invalid, in dark and light', async ({ page }) => {
    await openPanel(page);
    await openDecoder(page);
    expect(await scanWcag(page)).toEqual([]);
    await paste(page, DECODER_JWT);
    await decoded(page);
    expect(await scanWcag(page)).toEqual([]);
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveClass(/light/);
    expect(await scanWcag(page)).toEqual([]);
    await field(page).fill(MALFORMED);
    await decoded(page);
    expect(await scanWcag(page)).toEqual([]);
  });

  test('narrow layout stacks input above output with every action usable and no page overflow', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 420, height: 760 });
    await openPanel(page);
    for (const name of ['Overview', 'Requests', 'Timeline', 'Decoder']) {
      await expect(nav(page).getByRole('button', { name }), `${name} is visible without scrolling the toolbar`).toBeInViewport({ ratio: 1 });
    }
    await nav(page).getByRole('button', { name: 'Decoder' }).click();
    await expect(page.getByTestId('decoder-workspace')).toHaveAttribute('data-layout', 'narrow');
    await paste(page, DECODER_JWT);
    await decoded(page);

    const inputBox = (await page.getByTestId('decoder-input-panel').boundingBox())!;
    const outputBox = (await page.getByTestId('decoder-output').boundingBox())!;
    expect(outputBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height - 1);
    for (const name of ['Copy token', 'Clear input']) await expect(page.getByRole('button', { name })).toBeInViewport();
    const payloadCopy = page.getByTestId('decoded-payload').getByRole('button', { name: 'Copy payload JSON' });
    await payloadCopy.scrollIntoViewIfNeeded();
    await expect(payloadCopy).toBeInViewport();
    await noHorizontalOverflow(page);
    const workspace = await page.getByTestId('decoder-workspace').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(workspace).toBeLessThanOrEqual(0);
    expect(await scanWcag(page)).toEqual([]);
    errors.assertClean();
  });

  test('visual baseline: decoded token in dark and light, invalid input, and narrow layout', async ({ page }) => {
    await openPanel(page);
    await openDecoder(page);
    await paste(page, DECODER_JWT);
    await decoded(page);
    await field(page).blur();
    await expect(page).toHaveScreenshot('decoder-dark.png', screenshotOptions(page));
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveClass(/light/);
    await expect(page).toHaveScreenshot('decoder-light.png', screenshotOptions(page));
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await field(page).fill(MALFORMED);
    await decoded(page);
    await field(page).blur();
    await expect(page).toHaveScreenshot('decoder-invalid-dark.png', screenshotOptions(page));
    await field(page).fill(DECODER_JWT);
    await decoded(page);
    await field(page).blur();
    await page.setViewportSize({ width: 420, height: 900 });
    await expect(page.getByTestId('decoder-workspace')).toHaveAttribute('data-layout', 'narrow');
    await expect(page).toHaveScreenshot('decoder-narrow-dark.png', screenshotOptions(page));
  });
});
