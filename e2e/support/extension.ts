import { chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The unpacked extension under test. Defaults to the local build; `TOKENLENS_EXTENSION_DIR` points
 * the `extension` and `devtools` projects at another folder, such as an extracted release ZIP,
 * so the packaged artifact itself can be exercised before it is published.
 */
export const DIST_DIR = resolve(process.env.TOKENLENS_EXTENSION_DIR ?? resolve(process.cwd(), 'dist'));

export interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}

export async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(DIST_DIR, 'manifest.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * Launches a fresh, temporary Chromium profile with the unpacked extension loaded. Headless runs
 * use Chromium's new headless mode, which supports extensions; pass headed=true for the real
 * DevTools session. The extension id is read from chrome://extensions because TokenLens has no
 * background service worker to discover it from.
 */
export async function launchWithExtension(options: { headed?: boolean; extraArgs?: string[] } = {}): Promise<ExtensionSession> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'tokenlens-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !options.headed,
    viewport: { width: 1400, height: 900 },
    args: [
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(options.extraArgs ?? []),
    ],
  });
  const extensionId = await discoverExtensionId(context);
  return { context, extensionId, userDataDir };
}

async function discoverExtensionId(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/');
    const item = page.locator('extensions-item').first();
    await item.waitFor({ state: 'attached', timeout: 15_000 });
    const id = await item.getAttribute('id');
    if (!id) throw new Error('extension id attribute missing on chrome://extensions');
    return id;
  } finally {
    await page.close();
  }
}
