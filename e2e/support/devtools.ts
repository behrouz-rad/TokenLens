import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIST_DIR } from './extension';

/**
 * Minimal Chrome DevTools Protocol client over the browser WebSocket endpoint. Playwright's own
 * CDP session cannot address the DevTools frontend window or the extension iframes it hosts, but
 * the raw browser endpoint can: `Target.attachToTarget` with `flatten: true` returns a session id
 * for the devtools:// page and for every chrome-extension:// frame inside it.
 */
export class RawCdp {
  private ws!: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, (value: CdpResponse) => void>();
  readonly events: { method: string; params: unknown; sessionId?: string }[] = [];

  static async connect(port: number): Promise<RawCdp> {
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const client = new RawCdp();
    client.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      client.ws.onopen = () => resolve();
      client.ws.onerror = () => reject(new Error('CDP websocket failed'));
    });
    client.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse & { method?: string; params?: unknown; sessionId?: string };
      if (message.id !== undefined && client.pending.has(message.id)) {
        client.pending.get(message.id)!(message);
        client.pending.delete(message.id);
      } else if (message.method) {
        client.events.push({ method: message.method, params: message.params, sessionId: message.sessionId });
      }
    };
    return client;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResponse> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async targets(): Promise<TargetInfo[]> {
    const response = await this.send('Target.getTargets');
    return (response.result as { targetInfos: TargetInfo[] }).targetInfos;
  }

  async attach(target: TargetInfo): Promise<string> {
    const response = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = (response.result as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) throw new Error(`could not attach to ${target.url}: ${JSON.stringify(response.error)}`);
    await this.send('Runtime.enable', {}, sessionId);
    return sessionId;
  }

  async evaluate<T>(sessionId: string, expression: string): Promise<T> {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (response.error) throw new Error(`CDP Runtime.evaluate failed: ${response.error.message}`);
    const result = response.result as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined;
    if (result?.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown'}`);
    }
    return result?.result?.value as T;
  }

  async screenshot(sessionId: string, file: string): Promise<void> {
    const response = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const data = (response.result as { data?: string } | undefined)?.data;
    if (!data) throw new Error('screenshot failed');
    await writeFile(file, Buffer.from(data, 'base64'));
  }

  async pressCtrlBracket(sessionId: string): Promise<void> {
    const key = { key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221, modifiers: 2 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }, sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, sessionId);
  }

  close(): void {
    this.ws.close();
  }
}

export interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
}

export interface DevtoolsSession {
  context: BrowserContext;
  page: Page;
  cdp: RawCdp;
  port: number;
  userDataDir: string;
}

/**
 * Launches Playwright's Chromium headed with the unpacked extension, DevTools auto-opened for
 * every tab, and a remote-debugging port for the raw CDP client. Branded Google Chrome ignores
 * --load-extension, so the bundled Chromium (or Chrome for Testing) is required here.
 */
export async function launchDevtoolsSession(options: { port?: number } = {}): Promise<DevtoolsSession> {
  const port = options.port ?? 9400 + Math.floor(Math.random() * 400);
  const userDataDir = await mkdtemp(join(tmpdir(), 'tokenlens-devtools-'));
  // Fresh profile, but DevTools should open undocked so the panel gets a realistic width; the
  // docked-right default inside a 1600px window leaves the extension panel in its narrow layout.
  await mkdir(join(userDataDir, 'Default'), { recursive: true });
  await writeFile(
    join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({ devtools: { preferences: { currentDockState: '"undocked"' } } })
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
      '--auto-open-devtools-for-tabs',
      `--remote-debugging-port=${port}`,
      '--window-size=1600,1000',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await RawCdp.connect(port);
  return { context, page, cdp, port, userDataDir };
}

/** DevTools renders its tab strip inside shadow roots; this walks them and returns the tab elements. */
export const DEVTOOLS_TAB_QUERY = `(() => {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.classList && el.classList.contains('tabbed-pane-header-tab')) out.push(el);
    }
  };
  walk(document);
  return out;
})()`;

export async function selectedDevtoolsTab(cdp: RawCdp, devtoolsSession: string): Promise<string | undefined> {
  return cdp.evaluate<string | undefined>(devtoolsSession, `${DEVTOOLS_TAB_QUERY}.filter(t => t.classList.contains('selected')).map(t => t.textContent.trim())[0]`);
}

export async function visibleDevtoolsTabs(cdp: RawCdp, devtoolsSession: string): Promise<string[]> {
  return cdp.evaluate<string[]>(devtoolsSession, `${DEVTOOLS_TAB_QUERY}.map(t => t.textContent.trim())`);
}

/**
 * Cycles DevTools panels with Ctrl+] (the native "next panel" shortcut) until the named tab is
 * selected. Tabs hidden in the overflow menu are reachable this way even though they are not in
 * the DOM, which is what makes it more reliable than clicking.
 */
export async function activateDevtoolsPanel(cdp: RawCdp, devtoolsSession: string, name: string, maxSteps = 30): Promise<string[]> {
  const visited: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const current = await selectedDevtoolsTab(cdp, devtoolsSession);
    if (current) visited.push(current);
    if (current === name) return visited;
    await cdp.pressCtrlBracket(devtoolsSession);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`DevTools tab "${name}" not reached; visited: ${visited.join(' -> ')}`);
}

export async function waitForTarget(cdp: RawCdp, predicate: (t: TargetInfo) => boolean, timeoutMs = 15_000): Promise<TargetInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await cdp.targets()).find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('target did not appear in time');
}

/**
 * Below 720px the panel shows one column at a time (Tokens / Details / Inspector). When DevTools
 * is docked narrow, tests switch to the view that holds the element they need; in the wide
 * layout this is a no-op. Returns the panel width so tests can record it.
 */
export async function ensurePanelView(cdp: RawCdp, panelSession: string, view: 'tokens' | 'details' | 'inspector'): Promise<number> {
  const label = view === 'tokens' ? 'Tokens' : view === 'details' ? 'Details' : 'Inspector';
  return cdp.evaluate<number>(
    panelSession,
    `(() => {
      const narrow = document.querySelector('[data-testid=narrow-layout]');
      if (narrow) {
        const tab = [...narrow.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === ${JSON.stringify(label)});
        if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
      }
      return window.innerWidth;
    })()`
  );
}

export async function waitForEvaluation<T>(cdp: RawCdp, sessionId: string, expression: string, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await cdp.evaluate<T>(sessionId, expression);
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`condition not met in time; last value: ${JSON.stringify(last)}`);
}
