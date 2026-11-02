import { expect, type ConsoleMessage, type Page } from '@playwright/test';
import type { CaptureObservation } from '@/core/capture/observation';
import { captureChannelName } from '@/core/capture/channel';
import { createSyntheticJwt, withBearer } from '@/core/testing/synthetic';

export const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
export const PANEL_PATH = '/src/devtools/panel/panel.html';
const seconds = (ms: number) => Math.floor(ms / 1000);

export interface ErrorCollector {
  errors: string[];
  assertClean(): void;
}

/** Fails a test on any page error or console error, with browser noise that is not ours filtered out. */
export function collectErrors(page: Page): ErrorCollector {
  const errors: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('favicon.ico')) return;
    errors.push(`console.error: ${text}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return {
    errors,
    assertClean: () => expect(errors, 'no runtime errors expected').toEqual([]),
  };
}

export async function openPanel(page: Page, options: { fixedTime?: number | null; theme?: 'dark' | 'light' } = {}): Promise<void> {
  if (options.fixedTime !== null) await page.clock.setFixedTime(options.fixedTime ?? FIXED_NOW);
  await page.goto(PANEL_PATH);
  await expect(page.getByText('TokenLens', { exact: true })).toBeVisible();
}

export async function feedObservations(page: Page, observations: CaptureObservation[], scope = 'standalone'): Promise<void> {
  await page.evaluate(
    ({ name, message }) => {
      const channel = new BroadcastChannel(name);
      channel.postMessage(message);
      channel.close();
    },
    {
      name: captureChannelName(scope),
      message: { type: 'observations', from: 'relay', relayId: 'e2e-relay', scope, observations },
    }
  );
}

export function buildScenario(now: number = FIXED_NOW): { observations: CaptureObservation[]; tokens: Record<string, string> } {
  const tokens = {
    access: createSyntheticJwt(
      { alg: 'RS256', typ: 'at+jwt', kid: 'e2e-key' },
      { iss: 'https://issuer.example.test', sub: 'user-1', aud: 'api://demo', exp: seconds(now) + 3600, iat: seconds(now) - 60, scope: 'read write', org: { id: 'o-1', tags: ['a', 'b'] } }
    ),
    expiring: createSyntheticJwt({ alg: 'HS256' }, { sub: 'user-2', exp: seconds(now) + 120 }),
    expired: createSyntheticJwt({ alg: 'HS256' }, { sub: 'user-3', iss: 'https://old.example.test', exp: seconds(now) - 3600 }),
    noExpiry: createSyntheticJwt({ alg: 'HS256' }, { sub: 'batch' }),
    unicode: createSyntheticJwt({ alg: 'ES256' }, { sub: 'ünïcødé', name: 'Zoë 🔐 東京', exp: seconds(now) + 3600 }),
    longClaims: createSyntheticJwt({ alg: 'ES256' }, { sub: 'x'.repeat(400), exp: seconds(now) + 3600, url: `https://very.long.example.test/${'segment/'.repeat(40)}` }),
    opaque: 'e2e-opaque-synthetic-token-0001',
    malformed: 'eyJhbGciOiJSUzI1NiJ9.!!!.sig',
  };
  const observations: CaptureObservation[] = [
    withBearer(tokens.access, { url: 'https://api.example.test/users', startedAt: now - 50_000 }),
    withBearer(tokens.access, { url: 'https://api.example.test/orders', method: 'POST', status: 201, statusText: 'Created', startedAt: now - 40_000 }),
    withBearer(tokens.access, { url: 'https://api.example.test/admin', status: 403, statusText: 'Forbidden', startedAt: now - 30_000 }),
    withBearer(tokens.expiring, { url: 'https://api.example.test/soon', startedAt: now - 25_000 }),
    withBearer(tokens.expired, { url: 'https://old.example.test/profile', status: 401, statusText: 'Unauthorized', startedAt: now - 20_000 }),
    withBearer(tokens.noExpiry, { url: 'https://legacy.example.test/jobs', startedAt: now - 15_000 }),
    withBearer(tokens.unicode, { url: 'https://api.example.test/me', startedAt: now - 12_000 }),
    withBearer(tokens.longClaims, { url: `https://very.long.example.test/${'segment/'.repeat(40)}`, startedAt: now - 11_000 }),
    withBearer(tokens.opaque, { url: 'https://oauth.example.test/userinfo', startedAt: now - 10_000 }),
    withBearer(tokens.malformed, { url: 'https://api.example.test/broken', status: 500, statusText: 'Internal Server Error', startedAt: now - 5_000 }),
  ];
  return { observations, tokens };
}

export const tokenItems = (page: Page) => page.getByTestId('token-item');
export const tokenItemNamed = (page: Page, name: string) => page.getByTestId('token-item').filter({ hasText: name }).first();
