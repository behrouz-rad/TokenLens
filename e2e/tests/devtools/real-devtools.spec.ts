import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  activateDevtoolsPanel,
  ensurePanelView,
  launchDevtoolsSession,
  visibleDevtoolsTabs,
  waitForEvaluation,
  waitForTarget,
  type DevtoolsSession,
} from '../../support/devtools';
import { createSyntheticJwt } from '@/core/testing/synthetic';

/**
 * Tests the real thing: Chrome DevTools opened on the fixture app, the TokenLens tab registered by
 * the extension's devtools_page, and the panel iframe capturing live traffic through
 * chrome.devtools.network. Runs headed; excluded from the default CI gate (see playwright.config.ts).
 *
 * DevTools may recreate the extension panel frame (on navigation, and occasionally while laying
 * out a freshly shown panel). The relay in the DevTools page survives and replays, so the product
 * behaves correctly; the test therefore re-attaches to the new frame whenever its CDP session dies.
 */
const ARTIFACTS = join(process.cwd(), 'e2e', '.artifacts');
const q = (selector: string, prop = 'textContent') => `document.querySelector(${JSON.stringify(selector)})?.${prop}`;
const count = (selector: string) => `document.querySelectorAll(${JSON.stringify(selector)}).length`;
/** Finite animations (colour transitions) still running; infinite pulses are ignored. */
const NO_RUNNING_ANIMATIONS = `document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length`;

test.describe('TokenLens inside real Chrome DevTools', () => {
  let session: DevtoolsSession;
  let devtools: string;
  let devtoolsTargetId: string;
  let panel: string | null = null;
  let panelTargetId: string | null = null;
  let panelRecreations = 0;

  async function attachPanel(): Promise<string> {
    const target = await waitForTarget(session.cdp, (t) => t.url.includes('/src/devtools/panel/panel.html') && t.targetId !== panelTargetId);
    panelTargetId = target.targetId;
    panel = await session.cdp.attach(target);
    await session.cdp.send('Log.enable', {}, panel);
    return panel;
  }

  const isSessionLoss = (error: unknown) => /wasn't found|No session|Session with given id|Target closed/i.test(String(error));

  /** Runs an operation against the panel session, re-attaching once if DevTools replaced the frame. */
  async function withPanel<T>(operation: (sessionId: string) => Promise<T>): Promise<T> {
    if (!panel) await attachPanel();
    try {
      return await operation(panel!);
    } catch (error) {
      if (!isSessionLoss(error)) throw error;
      panelRecreations += 1;
      await attachPanel();
      return operation(panel!);
    }
  }

  const pe = <T,>(expression: string) => withPanel((sessionId) => session.cdp.evaluate<T>(sessionId, expression));

  async function waitPanel<T>(expression: string, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await pe<T>(expression);
      if (accept(last)) return last;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`condition not met in time; last value: ${JSON.stringify(last)}`);
  }

  const view = (name: 'tokens' | 'details' | 'inspector') => withPanel((sessionId) => ensurePanelView(session.cdp, sessionId, name));

  const clickByText = (tag: string, text: string) =>
    pe<boolean>(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(tag)})].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}) || b.getAttribute('aria-label') === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`
    );

  test.beforeAll(async ({ baseURL }) => {
    await mkdir(ARTIFACTS, { recursive: true });
    session = await launchDevtoolsSession();
    await session.page.goto(`${baseURL}/app/`);
    await session.page.waitForSelector('body[data-fixture-ready="true"]');
    const devtoolsTarget = await waitForTarget(session.cdp, (t) => t.url.startsWith('devtools://'));
    devtoolsTargetId = devtoolsTarget.targetId;
    devtools = await session.cdp.attach(devtoolsTarget);
  });

  test.afterAll(async () => {
    test.info().annotations.push({ type: 'panel-recreations', description: String(panelRecreations) });
    session?.cdp.close();
    await session?.context.close();
  });

  test('the extension registers its DevTools page and a TokenLens tab', async () => {
    const devtoolsPage = await waitForTarget(session.cdp, (t) => t.url.includes('/src/devtools/devtools.html'));
    expect(devtoolsPage.url).toMatch(/^chrome-extension:\/\/[a-p]{32}\/src\/devtools\/devtools\.html$/);
    const extensionPage = await session.cdp.attach(devtoolsPage);
    // The target is listed before its module script has run, so the relay is awaited rather than read once.
    const relay = await waitForEvaluation<{ relay: boolean; tabId: number }>(
      session.cdp,
      extensionPage,
      `({ relay: !!window.__tokenlensRelay, tabId: chrome.devtools.inspectedWindow.tabId })`,
      (value) => value.relay
    );
    expect(relay.relay).toBe(true);
    expect(relay.tabId).toBeGreaterThan(0);

    const visited = await activateDevtoolsPanel(session.cdp, devtools, 'TokenLens');
    test.info().annotations.push({ type: 'devtools-tabs', description: visited.join(' -> ') });
    expect(visited.at(-1)).toBe('TokenLens');
    expect(await visibleDevtoolsTabs(session.cdp, devtools)).toContain('TokenLens');
  });

  test('the panel iframe loads inside DevTools without errors', async () => {
    const title = await waitPanel<string>(`document.title + '|' + (${q('[data-testid=status-token-count]')} ?? '')`, (v) => v.includes('Captured'));
    expect(title).toMatch(/^TokenLens\|Captured/);
    expect(await pe<boolean>(`document.documentElement.classList.contains('dark')`)).toBe(true);
    expect(await pe<number>(`chrome.devtools.inspectedWindow.tabId`)).toBeGreaterThan(0);
  });

  test('live Bearer traffic from the inspected page is captured, decoded and correlated', async () => {
    const results = await session.page.evaluate(() => window.tokenlensFixture.runAll());
    expect(results.length).toBe(15);

    expect(await waitPanel<string>(q('[data-testid=status-token-count]'), (v) => v === 'Captured 10 tokens', 20_000)).toBe('Captured 10 tokens');
    expect(await pe<string>(q('[data-testid=status-request-count]'))).toBe('Requests with Bearer: 13');
    const breakdown = await pe<string>(q('[data-testid=status-http-breakdown]'));
    expect(breakdown).toContain('2xx: 9');
    expect(breakdown).toContain('4xx: 3');
    expect(breakdown).toContain('5xx: 1');

    const width = await view('details');
    test.info().annotations.push({ type: 'panel-width', description: `${width}px` });
    await waitPanel<string>(q('[data-testid=token-header-name]'), (v) => typeof v === 'string');
    expect(await pe<string>(q('[data-testid=token-header-name]'))).toBe('access_token');
    const header = await pe<string>(q('[data-testid=token-header]'));
    expect(header).toContain('JWT (Access)');
    expect(header).toContain('Signature present, not verified');
    expect(header).toContain('https://issuer.fixture.test');

    const table = await pe<string>(q('[data-testid=request-table]'));
    expect(table).toContain('Used in requests (4)');
    expect(table).toContain('/api/forbidden');
    expect(await pe<number>(count('[data-testid=request-row]'))).toBe(4);
    expect(await pe<string>(q('[data-testid=token-timeline]'))).toContain('POST /api/created');

    await view('inspector');
    await waitPanel<string>(q('[data-testid=diagnostics-panel]'), (v) => typeof v === 'string');
    const diagnostics = await pe<string>(q('[data-testid=diagnostics-panel]'));
    expect(diagnostics).toContain('Not measured');
    expect(diagnostics).toContain('1 request forbidden');
    expect(diagnostics).not.toContain('keys available');

    await view('tokens');
    await waitPanel<number>(NO_RUNNING_ANIMATIONS, (v) => v === 0);
    await session.cdp.screenshot(devtools, join(ARTIFACTS, 'real-devtools-dark.png'));
  });

  test('the Requests explorer and global Timeline work inside DevTools and link back to the Overview', async () => {
    expect(await clickByText('button', 'Requests')).toBe(true);
    await waitPanel<string>(q('[data-testid=requests-heading]'), (v) => v === 'Requests (13)');
    expect(await pe<number>(count('[data-testid=requests-explorer] [data-testid=request-row]'))).toBe(13);
    expect(await pe<string>(q('[data-testid=requests-explorer]'))).toContain('127.0.0.1');
    expect(await pe<boolean>(`(() => { const b = [...document.querySelectorAll('[role=group][aria-label="Filter by HTTP status"] button')].find(x => x.textContent.startsWith('4xx')); b?.click(); return !!b; })()`)).toBe(true);
    await waitPanel<string>(q('[data-testid=requests-heading]'), (v) => v === 'Requests (3 of 13)');
    await waitPanel<number>(NO_RUNNING_ANIMATIONS, (v) => v === 0);
    await session.cdp.screenshot(devtools, join(ARTIFACTS, 'real-devtools-requests.png'));
    expect(await pe<boolean>(`(() => { const b = [...document.querySelectorAll('[role=group][aria-label="Filter by HTTP status"] button')].find(x => x.textContent.startsWith('All')); b?.click(); return !!b; })()`)).toBe(true);
    await waitPanel<string>(q('[data-testid=requests-heading]'), (v) => v === 'Requests (13)');

    expect(await clickByText('button', 'Timeline')).toBe(true);
    await waitPanel<string>(q('[data-testid=timeline-heading]'), (v) => /Timeline \(\d+ events\)/.test(v));
    const timelineText = await pe<string>(q('[data-testid=global-timeline]'));
    expect(timelineText).toContain('First observed');
    expect(timelineText).toContain('Issued (iat claim)');
    expect(timelineText).not.toMatch(/refresh/i);
    expect(await pe<number>(count('[data-testid=global-timeline-event][data-basis=claim]'))).toBeGreaterThan(0);
    expect(await pe<number>(count('[data-testid=global-timeline-event][data-basis=observed]'))).toBeGreaterThan(0);
    await waitPanel<number>(NO_RUNNING_ANIMATIONS, (v) => v === 0);
    await session.cdp.screenshot(devtools, join(ARTIFACTS, 'real-devtools-timeline.png'));

    expect(await pe<boolean>(`(() => { const b = [...document.querySelectorAll('[data-testid=global-timeline-event] button')].find(x => /Show id_token #\\d+ in Overview/.test(x.getAttribute('aria-label') ?? '')); b?.click(); return !!b; })()`)).toBe(true);
    await view('details');
    await waitPanel<string>(q('[data-testid=token-header-name]'), (v) => v === 'id_token');
    await view('tokens');
  });

  test('tokens of every format appear with honest classification', async () => {
    await view('tokens');
    const items = await pe<string[]>(`[...document.querySelectorAll('[data-testid=token-item]')].map(i => i.textContent)`);
    const joined = items.join('\n');
    expect(joined).toContain('access_token');
    expect(joined).toContain('id_token');
    expect(joined).toContain('bearer_token');
    expect(joined).toContain('malformed_token');
    expect(joined).toContain('No expiry');
    expect(joined).toContain('Expiring');
    expect(joined).not.toContain('user-expired');
    expect(await pe<string>(q('[data-testid=quick-filter-count-only-expired]'))).toBe('1');
    expect(await pe<string>(q('[data-testid=quick-filter-count-failed-requests]'))).toBe('3');
  });

  test('the Decoder decodes pasted input inside DevTools and leaves the capture session alone', async () => {
    const seconds = Math.floor(Date.now() / 1000);
    const token = createSyntheticJwt(
      { alg: 'RS256', typ: 'at+jwt', kid: 'decoder-key-1' },
      { iss: 'https://issuer.decoder.test', sub: 'decoder-user', aud: 'api://decoder', exp: seconds + 3600, iat: seconds - 120, scope: 'read write', profile: { name: 'Zoë 🔐 東京', roles: ['viewer', 'editor'] } }
    );
    const capturedBefore = await pe<string>(q('[data-testid=status-token-count]'));
    const requestsBefore = await pe<string>(q('[data-testid=status-request-count]'));
    const decoderState = q('[data-testid=status-decoder-state]');
    // execCommand('insertText') goes through the browser's editing pipeline, so React sees a native input event, as with a paste.
    const enter = (text: string) =>
      pe<boolean>(
        `(() => { const el = document.querySelector('[data-testid=decoder-input]'); el.focus(); el.select(); const ok = document.execCommand('insertText', false, ${JSON.stringify(text)}); el.blur(); return ok; })()`
      );

    expect(await clickByText('button', 'Decoder')).toBe(true);
    await waitPanel<string>(decoderState, (v) => v === 'Waiting for input');
    expect(await pe<string>(q('[data-testid=decoder-output]'))).toContain('Paste a JWT to inspect its header and payload.');
    expect(await enter(`Bearer ${token}`)).toBe(true);
    await waitPanel<string>(decoderState, (v) => v === 'JWT decoded · signature not verified');
    expect(await pe<string>(q('[data-testid=decoder-token-type]'))).toBe('JWT (Access)');
    expect(await pe<string>(q('[data-testid=decoder-facts]'))).toContain('Signature present, not verified');
    expect(await pe<string>(q('[data-testid=decoded-payload]'))).toContain('Zoë 🔐 東京');
    expect(await pe<string>(q('[data-testid=decoder-diagnostics]'))).not.toContain('HTTP');
    await waitPanel<number>(NO_RUNNING_ANIMATIONS, (v) => v === 0);
    await session.cdp.screenshot(devtools, join(ARTIFACTS, 'real-devtools-decoder-dark.png'));

    expect(await clickByText('button', 'Switch to light theme')).toBe(true);
    await waitPanel<boolean>(`document.documentElement.classList.contains('light')`, (v) => v === true);
    await waitPanel<number>(NO_RUNNING_ANIMATIONS, (v) => v === 0);
    await session.cdp.screenshot(devtools, join(ARTIFACTS, 'real-devtools-decoder-light.png'));
    expect(await clickByText('button', 'Switch to dark theme')).toBe(true);
    await waitPanel<boolean>(`document.documentElement.classList.contains('dark')`, (v) => v === true);

    expect(await enter('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJicm9rZW4.!!!')).toBe(true);
    await waitPanel<string>(decoderState, (v) => v === 'Malformed JWT');
    expect(await pe<string>(q('[data-testid=decoder-feedback]'))).toContain('Payload segment is not valid JSON');
    expect(await pe<number>(count('[data-testid=decoded-payload]'))).toBe(0);
    await waitPanel<number>(NO_RUNNING_ANIMATIONS, (v) => v === 0);
    await session.cdp.screenshot(devtools, join(ARTIFACTS, 'real-devtools-decoder-invalid.png'));

    expect(await enter(token)).toBe(true);
    await waitPanel<string>(decoderState, (v) => v === 'JWT decoded · signature not verified');
    const devtoolsWindow = (await session.cdp.send('Browser.getWindowForTarget', { targetId: devtoolsTargetId })).result as { windowId: number; bounds: Record<string, unknown> };
    await session.cdp.send('Browser.setWindowBounds', { windowId: devtoolsWindow.windowId, bounds: { width: 560 } });
    try {
      await waitPanel<string | null>(`document.querySelector('[data-testid=decoder-workspace]')?.dataset.layout ?? null`, (v) => v === 'narrow');
      const overflow = await pe<number>(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      expect(overflow).toBeLessThanOrEqual(0);
      const navVisible = await pe<boolean>(
        `[...document.querySelectorAll('nav[aria-label="Main sections"] button')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })`
      );
      expect(navVisible).toBe(true);
      await waitPanel<number>(NO_RUNNING_ANIMATIONS, (v) => v === 0);
      await session.cdp.screenshot(devtools, join(ARTIFACTS, 'real-devtools-decoder-narrow.png'));
    } finally {
      await session.cdp.send('Browser.setWindowBounds', { windowId: devtoolsWindow.windowId, bounds: { width: devtoolsWindow.bounds.width } });
    }
    await waitPanel<string | null>(`document.querySelector('[data-testid=decoder-workspace]')?.dataset.layout ?? null`, (v) => v === 'wide');

    expect(await clickByText('button', 'Overview')).toBe(true);
    await waitPanel<string>(q('[data-testid=status-token-count]'), (v) => typeof v === 'string');
    expect(await pe<string>(q('[data-testid=status-token-count]'))).toBe(capturedBefore);
    expect(await pe<string>(q('[data-testid=status-request-count]'))).toBe(requestsBefore);
    expect(await clickByText('button', 'Decoder')).toBe(true);
    await waitPanel<string>(decoderState, (v) => v === 'JWT decoded · signature not verified');
    expect(await pe<string>(`document.querySelector('[data-testid=decoder-input]').value`)).toBe(token);
    expect(await clickByText('button', 'Overview')).toBe(true);
  });

  test('controls work inside DevTools: selection, filters, pause/resume, theme, clear', async () => {
    await view('tokens');
    expect(await clickByText('button', 'Only expired')).toBe(true);
    expect(await waitPanel<string>(q('[data-testid=status-filter-summary]'), (v) => v.startsWith('Showing 1 of'))).toBe('Showing 1 of 10 tokens');
    expect(await pe<string>(`[...document.querySelectorAll('[data-testid=token-item]')].map(i => i.textContent).join()`)).toContain('Expired');
    expect(await clickByText('button', 'Only expired')).toBe(true);
    await waitPanel<string>(q('[data-testid=status-filter-summary]'), (v) => v === 'Showing all data');

    expect(await pe<boolean>(`(() => { const el = document.querySelector('[data-testid=token-item]'); el?.click(); return !!el; })()`)).toBe(true);
    expect(await clickByText('button', 'Recording')).toBe(true);
    await waitPanel<string>(q('[data-testid=status-paused]'), (v) => typeof v === 'string' && v.includes('Paused'));
    await session.page.evaluate(() => window.tokenlensFixture.run('active-ok'));
    await waitPanel<string>(q('[data-testid=status-paused]'), (v) => v.includes('1 skipped'));
    expect(await pe<string>(q('[data-testid=status-request-count]'))).toBe('Requests with Bearer: 13');
    expect(await clickByText('button', 'Paused')).toBe(true);
    await session.page.evaluate(() => window.tokenlensFixture.run('active-ok'));
    await waitPanel<string>(q('[data-testid=status-request-count]'), (v) => v === 'Requests with Bearer: 14');

    expect(await clickByText('button', 'Switch to light theme')).toBe(true);
    await waitPanel<boolean>(`document.documentElement.classList.contains('light')`, (v) => v === true);
    await waitPanel<number>(NO_RUNNING_ANIMATIONS, (v) => v === 0);
    await session.cdp.screenshot(devtools, join(ARTIFACTS, 'real-devtools-light.png'));
    expect(await clickByText('button', 'Switch to dark theme')).toBe(true);
    await waitPanel<boolean>(`document.documentElement.classList.contains('dark')`, (v) => v === true);

    expect(await clickByText('button', 'Clear captured tokens and requests')).toBe(true);
    await waitPanel<string>(q('[data-testid=status-token-count]'), (v) => v === 'Captured 0 tokens');
  });

  test('page reload keeps capture working, honours the earlier clear, and does not duplicate records', async () => {
    await session.page.reload();
    await session.page.waitForSelector('body[data-fixture-ready="true"]');
    await waitPanel<string>(q('[data-testid=status-token-count]'), (v) => typeof v === 'string', 20_000);
    await session.page.evaluate(() => window.tokenlensFixture.run('active-ok'));
    await session.page.evaluate(() => window.tokenlensFixture.run('active-ok'));
    expect(await waitPanel<string>(q('[data-testid=status-request-count]'), (v) => v === 'Requests with Bearer: 2', 20_000)).toBe('Requests with Bearer: 2');
    expect(await pe<string>(q('[data-testid=status-token-count]'))).toBe('Captured 1 token');
    await new Promise((r) => setTimeout(r, 2500));
    expect(await pe<string>(q('[data-testid=status-request-count]'))).toBe('Requests with Bearer: 2');
  });

  test('no runtime errors were logged by any panel frame', () => {
    const errors = session.cdp.events.filter(
      (e) =>
        e.sessionId !== devtools &&
        (e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && (e.params as { entry?: { level?: string } }).entry?.level === 'error'))
    );
    expect(errors.map((e) => JSON.stringify(e.params).slice(0, 200))).toEqual([]);
  });
});

declare global {
  interface Window {
    tokenlensFixture: {
      run: (id: string) => Promise<number>;
      runAll: () => Promise<[string, number][]>;
      burst: (count: number, token?: string) => Promise<number>;
      manyTokens: (count: number) => Promise<number>;
    };
  }
}
