import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIST_DIR, launchWithExtension, readManifest, type ExtensionSession } from '../../support/extension';
import { buildScenario, collectErrors, feedObservations } from '../../support/panel';
import { captureChannelName } from '@/core/capture/channel';

test.describe('installed extension (persistent Chromium context)', () => {
  let session: ExtensionSession;

  test.beforeAll(async () => {
    expect(existsSync(join(DIST_DIR, 'manifest.json')), 'run `npm run build` first').toBe(true);
    session = await launchWithExtension();
  });

  test.afterAll(async () => {
    await session?.context.close();
  });

  test('production manifest is a minimal Manifest V3 DevTools extension', async () => {
    const manifest = await readManifest();
    expect(manifest).toMatchObject({ manifest_version: 3, name: 'TokenLens', devtools_page: 'src/devtools/devtools.html' });
    expect(manifest.permissions ?? []).toEqual([]);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.background).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    const csp = (manifest.content_security_policy as { extension_pages?: string } | undefined)?.extension_pages ?? '';
    expect(csp).not.toMatch(/unsafe-eval|http:/);
    expect(existsSync(join(DIST_DIR, 'src/devtools/devtools.html'))).toBe(true);
    expect(existsSync(join(DIST_DIR, 'src/devtools/panel/panel.html'))).toBe(true);
  });

  test('extension loads without errors and exposes a 32-character id', async () => {
    expect(session.extensionId).toMatch(/^[a-p]{32}$/);
    const page = await session.context.newPage();
    await page.goto('chrome://extensions/');
    const item = page.locator(`extensions-item#${session.extensionId}`);
    await expect(item).toBeAttached();
    await expect(item.locator('#name')).toContainText('TokenLens');
    const errorsButton = item.locator('#errors-button');
    expect(await errorsButton.count() === 0 || (await errorsButton.isHidden())).toBe(true);
    await page.close();
  });

  test('panel page runs inside the extension origin, shows the real empty state and accepts the capture protocol', async () => {
    const page = await session.context.newPage();
    const errors = collectErrors(page);
    await page.goto(`chrome-extension://${session.extensionId}/src/devtools/panel/panel.html`);
    await expect(page.getByText('TokenLens', { exact: true })).toBeVisible();
    await expect(page.getByText('No tokens captured yet')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);

    const hasDevtoolsApi = await page.evaluate(() => typeof chrome !== 'undefined' && chrome.devtools?.inspectedWindow != null);
    expect(hasDevtoolsApi).toBe(false);

    await feedObservations(page, buildScenario().observations, 'standalone');
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 8 tokens');
    await expect(page.getByTestId('token-header-name')).toHaveText('access_token');
    expect(captureChannelName('standalone')).toBe('tokenlens:capture:standalone');
    errors.assertClean();
    await page.close();
  });

  test('extension pages never contact the network with token material', async () => {
    const page = await session.context.newPage();
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('chrome-extension://')) external.push(url);
    });
    await page.goto(`chrome-extension://${session.extensionId}/src/devtools/panel/panel.html`);
    await feedObservations(page, buildScenario().observations, 'standalone');
    await expect(page.getByTestId('status-token-count')).toHaveText('Captured 8 tokens');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await page.getByRole('tab', { name: 'Raw' }).click();
    expect(external).toEqual([]);
    await page.close();
  });
});
