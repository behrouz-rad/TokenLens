import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVTOOLS_TAB_QUERY, RawCdp, waitForTarget } from '../e2e/support/devtools';
import { DIST_DIR } from '../e2e/support/extension';

/**
 * Films the real TokenLens extension inside real Chrome DevTools and writes a Screenplay take
 * (frames + a timeline of every action, with element boxes) that `screenplay render` edits.
 *
 * Screenplay's own recorder drives a fresh headless page, which cannot host DevTools or its
 * extension panels. This recorder keeps Screenplay's take format and timing rules but drives
 * the DevTools frontend over the raw CDP endpoint the repository's DevTools tests already use:
 *  - frames come from Page.startScreencast on the devtools:// target, so only the DevTools window
 *    is filmed (no desktop, notifications or other windows can appear);
 *  - input is real (Input.dispatchMouseEvent on the DevTools window), so hover, focus and click
 *    behaviour is the product's own, and the real pointer follows the path the edit draws.
 *
 * DEMO_CHECK=1 rehearses quickly without filming and saves one screenshot per step.
 */

const DEMO_DIR = join(process.cwd(), 'demo');
const WORK = join(DEMO_DIR, 'work');
const TAKE_DIR = join(WORK, '.screenplay', 'takes', 'tokenlens-demo');
const CHECK = process.env.DEMO_CHECK === '1';
const DEMO_PORT = Number(process.env.TOKENLENS_DEMO_PORT ?? 4180);
const PANEL_URL = '/src/devtools/panel/panel.html';

interface Direction {
  index: number;
  kind: string;
  scene: string;
  target?: string;
  seconds?: number;
  play?: string;
  wheel?: number;
  paste?: string;
  expect?: { in: string; text: string }[];
  hold?: number;
  duration?: number;
  minDuration: number;
}
interface Directions {
  viewport: { width: number; height: number; scale: number };
  steps: Direction[];
}
interface Point {
  x: number;
  y: number;
}
interface Box extends Point {
  width: number;
  height: number;
}
interface CaptureCounts {
  tokens: string;
  requests: string;
}
interface TakeStep {
  index: number;
  kind: string;
  label: string;
  start: number;
  end: number;
  travelStart?: number;
  actionAt?: number;
  point?: Point;
  box?: Box;
  waits: [number, number][];
  scrolls?: [number, number][];
}
interface Movement {
  s0: number;
  s1: number;
  from: Point;
  to: Point;
  bend: number;
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, Math.max(0, s) * 1000));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Screenplay's pacing (drivers/pace.js): how long the drawn cursor takes between two points. */
function travelDuration(from: Point, to: Point): number {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return d < 4 ? 0.15 : clamp(0.38 + d / 1700, 0.42, 1.05);
}

/** Screenplay's cursor path (direct/plan.js cursorAt): minimum-jerk motion along a gentle arc. */
function pathPoint(m: Movement, u: number): Point {
  const e = u * u * u * (10 - 15 * u + 6 * u * u);
  const dx = m.to.x - m.from.x;
  const dy = m.to.y - m.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const arc = Math.min(80, len * 0.12) * m.bend;
  const ctrl = { x: (m.from.x + m.to.x) / 2 - (dy / len) * arc, y: (m.from.y + m.to.y) / 2 + (dx / len) * arc };
  const a = 1 - e;
  return { x: a * a * m.from.x + 2 * a * e * ctrl.x + e * e * m.to.x, y: a * a * m.from.y + 2 * a * e * ctrl.y + e * e * m.to.y };
}

/**
 * Finds one visible element and returns its box and normalised text. Runs inside a document (the
 * panel or the DevTools frontend). Targets: css=, testid=, text= (exact, then prefix; smallest match),
 * role=<role>[name='…'], has=<text> (filter), nth=<n>, tab=<DevTools tab>; `a >> b` chains.
 */
const RESOLVE = String.raw`(chain) => {
  const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const squash = (s) => (s ?? '').replace(/\s+/g, '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const all = (root) => [root, ...root.querySelectorAll('*')];
  const implicitRole = (el) => ({ BUTTON: 'button', A: 'link', SELECT: 'combobox', NAV: 'navigation' })[el.tagName];
  let scope = [document.documentElement];
  for (const raw of chain.split(' >> ')) {
    const part = raw.trim();
    const i = part.indexOf('=');
    const kind = part.slice(0, i);
    const value = part.slice(i + 1);
    let next = [];
    if (kind === 'has') next = scope.filter((el) => squash(el.textContent).includes(squash(value)));
    else if (kind === 'nth') next = scope.slice(Number(value), Number(value) + 1);
    else if (kind === 'tab') next = ${DEVTOOLS_TAB_QUERY}.filter((t) => norm(t.textContent) === value);
    else {
      const pool = [...new Set(scope.flatMap((s) => all(s)))];
      if (kind === 'css') next = pool.filter((el) => el.matches(value));
      else if (kind === 'testid') next = pool.filter((el) => el.getAttribute('data-testid') === value);
      else if (kind === 'role') {
        const m = /^([a-z]+)(?:\[name='(.*)'\])?$/.exec(value);
        next = pool.filter((el) => (el.getAttribute('role') ?? implicitRole(el)) === m[1] && (m[2] === undefined || el.getAttribute('aria-label') === m[2] || norm(el.textContent) === m[2]));
      } else if (kind === 'text') {
        const exact = pool.filter((el) => norm(el.textContent) === value);
        const matches = exact.length ? exact : pool.filter((el) => norm(el.textContent).startsWith(value));
        next = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));
      } else throw new Error('unknown target kind ' + kind);
    }
    scope = next.filter(visible);
  }
  const el = scope[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, text: norm(el.textContent) };
}`;

/** Offset of the TokenLens iframe inside the DevTools frontend; extension views sit in shadow roots. */
const PANEL_OFFSET = String.raw`(() => {
  const found = [];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); if (el.tagName === 'IFRAME' && (el.src ?? '').includes('${PANEL_URL}')) found.push(el); } };
  walk(document);
  const r = found.map((f) => f.getBoundingClientRect()).find((b) => b.width > 0);
  return r ? { x: r.x, y: r.y } : null;
})()`;

/** The capture status bar's counts, or null while a section without it (the Decoder) is shown. */
const CAPTURE_COUNTS = String.raw`(() => {
  const tokens = document.querySelector('[data-testid=status-token-count]');
  const requests = document.querySelector('[data-testid=status-request-count]');
  return tokens && requests ? { tokens: tokens.textContent.trim(), requests: requests.textContent.trim() } : null;
})()`;
const REQUEST_COUNT = `Number(/(\\d+)$/.exec(document.querySelector('[data-testid=status-request-count]')?.textContent ?? '')?.[1] ?? 0)`;

/** Every profile and browser this run creates, so nothing is left behind even when a take is rejected. */
const launched: { profile: string; close: () => Promise<void> }[] = [];
test.afterAll(async () => {
  for (const { profile, close } of launched.splice(0)) {
    await close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('record TokenLens in real Chrome DevTools', async () => {
  const directions = JSON.parse(await readFile(join(WORK, 'directions.json'), 'utf8')) as Directions;
  const { width: W, height: H, scale } = directions.viewport;

  /**
   * The undocked DevTools window takes its size from the browser window, and the window frame
   * differs per system, so the profile is relaunched until the DevTools viewport is exactly W×H.
   */
  async function launch(windowSize: { w: number; h: number }) {
    const port = 9600 + Math.floor(Math.random() * 300);
    const userDataDir = await mkdtemp(join(tmpdir(), 'tokenlens-demo-'));
    await mkdir(join(userDataDir, 'Default'), { recursive: true });
    await writeFile(join(userDataDir, 'Default', 'Preferences'), JSON.stringify({ devtools: { preferences: { currentDockState: '"undocked"' } } }));
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      viewport: null,
      args: [
        `--disable-extensions-except=${DIST_DIR}`,
        `--load-extension=${DIST_DIR}`,
        '--auto-open-devtools-for-tabs',
        `--remote-debugging-port=${port}`,
        `--window-size=${windowSize.w},${windowSize.h}`,
        `--force-device-scale-factor=${scale}`,
        // DevTools follows the system theme by default; the video is shot in dark mode.
        '--force-dark-mode',
        // Reserved .test names (RFC 2606) resolve to the local synthetic backend.
        `--host-resolver-rules=MAP *.example.test 127.0.0.1:${DEMO_PORT}`,
        '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,CalculateNativeWinOcclusion,Translate',
        // Keep rendering when another window covers DevTools, or the screencast stalls.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    launched.push({ profile: userDataDir, close: () => ctx.close() });
    const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
    const client = await RawCdp.connect(port);
    await page.goto('http://app.example.test/');
    await page.waitForSelector('body[data-demo-ready="true"]');
    const target = await waitForTarget(client, (t) => t.url.startsWith('devtools://'));
    const devtools = await client.attach(target);
    let last = { w: 0, h: 0 };
    for (let i = 0; i < 40; i++) {
      const size = await client.evaluate<{ w: number; h: number }>(devtools, '({ w: innerWidth, h: innerHeight })');
      if (size.w === last.w && size.h === last.h && size.w > 0) break;
      last = size;
      await sleep(0.4);
    }
    return { ctx, page, client, devtools, size: last };
  }

  let windowSize = { w: W + 13, h: H + 35 };
  let session = await launch(windowSize);
  for (let attempt = 0; attempt < 3 && (session.size.w !== W || session.size.h !== H); attempt++) {
    windowSize = { w: windowSize.w + (W - session.size.w), h: windowSize.h + (H - session.size.h) };
    session.client.close();
    await session.ctx.close();
    session = await launch(windowSize);
  }
  const { ctx: context, client, page, devtools } = session;
  expect(session.size, 'DevTools viewport').toEqual({ w: W, h: H });

  // ---- panel frame -------------------------------------------------------------------------
  let panel: string | null = null;
  let panelTargetId: string | null = null;
  const attachPanel = async () => {
    const target = await waitForTarget(client, (t) => t.url.includes(PANEL_URL) && t.targetId !== panelTargetId, 20_000);
    panelTargetId = target.targetId;
    panel = await client.attach(target);
    return panel;
  };
  const isSessionLoss = (e: unknown) => /wasn't found|No session|Session with given id|Target closed/i.test(String(e));
  /** DevTools may recreate the extension frame; the relay replays, so re-attaching is enough. */
  async function inPanel<T>(expression: string): Promise<T> {
    const id = panel ?? (await attachPanel());
    try {
      return await client.evaluate<T>(id, expression);
    } catch (e) {
      if (!isSessionLoss(e)) throw e;
      return client.evaluate<T>(await attachPanel(), expression);
    }
  }
  async function waitPanel<T>(expression: string, accept: (v: T) => boolean, timeoutS = 20): Promise<T> {
    const deadline = Date.now() + timeoutS * 1000;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await inPanel<T>(expression).catch(() => undefined as T);
      if (last !== undefined && accept(last)) return last;
      await sleep(0.1);
    }
    throw new Error(`panel condition not met: ${expression}; last ${JSON.stringify(last)}`);
  }

  /**
   * Lowest y the real pointer may take on its way to a panel target. Crossing the DevTools tab
   * strip would leave a tab's hover "×" showing, because the frontend gets no mouse-leave once
   * the pointer is inside the extension frame. The drawn cursor keeps Screenplay's own arc.
   */
  let pointerFloor = 0;

  /** Box of a target in DevTools-window CSS pixels, waiting until it is present and still. */
  async function resolveBox(target: string, ts: TakeStep): Promise<Box> {
    const inDevtools = target.startsWith('devtools:');
    const chain = inDevtools ? target.slice('devtools:'.length) : target;
    const t0 = now();
    const deadline = Date.now() + 15_000;
    let prev: Box | null = null;
    while (Date.now() < deadline) {
      const box = inDevtools
        ? await client.evaluate<Box | null>(devtools, `(${RESOLVE})(${JSON.stringify(chain)})`)
        : await inPanel<Box | null>(`(${RESOLVE})(${JSON.stringify(chain)})`).catch(() => null);
      if (box && prev && Math.abs(box.x - prev.x) < 0.5 && Math.abs(box.y - prev.y) < 0.5 && Math.abs(box.width - prev.width) < 0.5) {
        const offset = inDevtools ? { x: 0, y: 0 } : await client.evaluate<Point | null>(devtools, PANEL_OFFSET);
        if (!offset) throw new Error('TokenLens panel frame not found in DevTools');
        pointerFloor = inDevtools ? 0 : offset.y + 4;
        if (now() - t0 > 0.4) ts.waits.push([t0, now()]);
        return { x: box.x + offset.x, y: box.y + offset.y, width: box.width, height: box.height };
      }
      prev = box;
      await sleep(0.08);
    }
    throw new Error(`step ${ts.index + 1}: target not found: ${target}`);
  }

  // ---- filming -----------------------------------------------------------------------------
  await rm(TAKE_DIR, { recursive: true, force: true });
  await mkdir(join(TAKE_DIR, 'frames'), { recursive: true });
  const checkDir = join(WORK, 'check');
  if (CHECK) await mkdir(checkDir, { recursive: true });
  const t0 = Date.now() / 1000;
  const now = () => Date.now() / 1000 - t0;
  const frames: [number, string][] = [];
  const writes: Promise<void>[] = [];
  const panelErrors: string[] = [];
  let frameNo = 0;
  const pump = setInterval(() => {
    const events = client.events.splice(0, client.events.length);
    for (const e of events) {
      if (e.method === 'Page.screencastFrame' && e.sessionId === devtools) {
        const p = e.params as { data: string; sessionId: number; metadata: { timestamp?: number } };
        const name = `f${String(++frameNo).padStart(6, '0')}.jpg`;
        frames.push([Math.max(0, (p.metadata.timestamp ?? Date.now() / 1000) - t0), name]);
        writes.push(writeFile(join(TAKE_DIR, 'frames', name), Buffer.from(p.data, 'base64')));
        void client.send('Page.screencastFrameAck', { sessionId: p.sessionId }, devtools);
      } else if (e.sessionId !== devtools && e.method === 'Runtime.exceptionThrown') {
        panelErrors.push(JSON.stringify(e.params).slice(0, 300));
      }
    }
  }, 8);

  if (!CHECK) {
    await client.send('Page.enable', {}, devtools);
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * scale, maxHeight: H * scale, everyNthFrame: 1 }, devtools);
    await sleep(0.8);
  }
  const pace = (s: number) => (CHECK ? Math.min(s, 0.15) : s);

  let cursor: Point = { x: W * 0.62, y: H * 0.7 };
  const cursorStart = { ...cursor };
  let bend = 1;
  const steps: TakeStep[] = [];
  let expectedRequests = 0;
  /** Capture counts as last shown, so sections without the capture status bar can be checked against them. */
  let capture: CaptureCounts | null = null;

  /**
   * Inserts a sample token from the demo page into the field the click just focused, in one
   * native text insertion (Input.insertText, as a paste delivers it): the panel receives real
   * input events and decodes on its own schedule. Nothing in the panel is set directly.
   */
  async function paste(sample: string, ts: TakeStep) {
    expect(capture, `step ${ts.index + 1}: capture counts must be known before pasting`).not.toBeNull();
    const text = await page.evaluate((name) => (window as unknown as { acmeDemo: { sample: (n: string) => string } }).acmeDemo.sample(name), sample);
    const focused = await waitPanel<string>(`document.activeElement?.tagName ?? ''`, (tag) => tag === 'TEXTAREA' || tag === 'INPUT', 5);
    expect(focused, `step ${ts.index + 1}: the click focused a text field`).toMatch(/TEXTAREA|INPUT/);
    const response = await client.send('Input.insertText', { text }, devtools);
    if (response.error) throw new Error(`step ${ts.index + 1}: Input.insertText failed: ${response.error.message}`);
  }

  /** Moves the real pointer along the same arc the edit will draw, so hover states match it. */
  async function travel(to: Point, ts: TakeStep) {
    ts.travelStart = now();
    const duration = travelDuration(cursor, to);
    if (Math.hypot(to.x - cursor.x, to.y - cursor.y) > 2) {
      const m: Movement = { s0: 0, s1: duration, from: cursor, to, bend };
      bend = -bend;
      const start = Date.now();
      for (;;) {
        const u = Math.min(1, (Date.now() - start) / 1000 / pace(duration));
        const p = pathPoint(m, u);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: Math.max(pointerFloor, p.y) }, devtools);
        if (u >= 1) break;
        await sleep(1 / 60);
      }
    }
    cursor = to;
    ts.point = to;
  }

  for (const d of directions.steps) {
    const ts: TakeStep = { index: d.index, kind: d.kind, label: `${d.kind} ${d.target ?? d.seconds ?? ''}`.trim(), start: now(), end: 0, waits: [] };
    process.stdout.write(`${CHECK ? 'check' : 'record'} ${d.index + 1}/${directions.steps.length} ${ts.label}\n`);
    switch (d.kind) {
      case 'click':
      case 'hover': {
        const box = await resolveBox(d.target ?? '', ts);
        ts.box = box;
        await travel({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, ts);
        ts.actionAt = now();
        if (d.kind === 'click') {
          const at = { x: cursor.x, y: cursor.y, button: 'left', clickCount: 1 };
          await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at }, devtools);
          await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at }, devtools);
        }
        if (d.paste) await paste(d.paste, ts);
        break;
      }
      case 'highlight':
      case 'callout':
      case 'zoomTo': {
        ts.box = await resolveBox(d.target ?? '', ts);
        ts.actionAt = now();
        const base = Math.max(d.duration ?? (d.kind === 'zoomTo' ? 2 : 3), d.minDuration);
        await sleep(pace(base + (d.kind === 'zoomTo' ? 0 : 0.55)));
        break;
      }
      case 'scroll': {
        const box = await resolveBox(d.target ?? '', ts);
        await travel({ x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 260) }, ts);
        ts.actionAt = now();
        // Real wheel input in small notches reads as one smooth scroll.
        const s0 = now();
        const notches = Math.ceil((d.wheel ?? 400) / 30);
        for (let i = 0; i < notches; i++) {
          await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cursor.x, y: cursor.y, deltaX: 0, deltaY: 30 }, devtools);
          await sleep(pace(1.1 / notches));
        }
        ts.scrolls = [[s0, now()]];
        break;
      }
      case 'pause':
        await sleep(pace(d.seconds ?? 1));
        break;
      default:
        throw new Error(`step kind ${d.kind} is not supported by the DevTools recorder`);
    }

    for (const e of d.expect ?? []) {
      // Semantic readiness: the real UI has to show the result before the step may end.
      const w0 = now();
      await waitPanel<string>(`(${RESOLVE})(${JSON.stringify(e.in)})?.text ?? ''`, (v) => v.includes(e.text), 10).catch(() => {
        throw new Error(`step ${d.index + 1}: "${e.text}" never appeared in ${e.in}`);
      });
      if (now() - w0 > 0.4) ts.waits.push([w0, now()]);
    }

    if (d.play) {
      // The first show of the TokenLens tab creates its frame; traffic starts once it is up, so
      // the inventory visibly fills in rather than appearing all at once.
      await waitPanel<string>(`document.querySelector('[data-testid=status-token-count]')?.textContent ?? ''`, (v) => v.startsWith('Captured'));
      await sleep(pace(0.3));
      const expected = await page.evaluate((name) => (window as unknown as { acmeDemo: { count: (n: string) => number } }).acmeDemo.count(name), d.play);
      void page.evaluate((name) => (window as unknown as { acmeDemo: { play: (n: string) => Promise<unknown> } }).acmeDemo.play(name), d.play);
      await waitPanel<number>(REQUEST_COUNT, (n) => n >= expected, 30);
      // The integrity settle shows nothing new, so the edit speeds it up like any wait.
      const settle = now();
      await sleep(0.3);
      ts.waits.push([settle, now()]);
      const seen = await inPanel<number>(REQUEST_COUNT);
      // Known intermittent capture issue: a getHAR() reconciliation that lands while a request
      // is in flight can add a status-less twin of that request. A take showing it misstates the
      // traffic, so it is rejected and reshot rather than edited (see demo/README.md).
      expect(seen, `Bearer requests captured for burst "${d.play}" (a duplicate means the in-flight HAR twin appeared; reshoot)`).toBe(expected);
      expectedRequests += expected;
    }

    capture = (await inPanel<CaptureCounts | null>(CAPTURE_COUNTS)) ?? capture;

    const hold = (d.hold ?? 0) + (d.kind === 'click' || d.kind === 'hover' ? 0.7 : 0.2);
    await sleep(pace(hold));
    const elapsed = now() - ts.start;
    if (!CHECK && elapsed < d.minDuration) await sleep(d.minDuration - elapsed);
    ts.end = now();
    steps.push(ts);
    if (CHECK) {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, devtools);
      await writeFile(join(checkDir, `${String(d.index + 1).padStart(2, '0')}.png`), Buffer.from((shot.result as { data: string }).data, 'base64'));
    }
  }

  await sleep(pace(0.7));
  const duration = now();
  if (!CHECK) await client.send('Page.stopScreencast', {}, devtools);

  // Off camera: the take may end in a section without the capture status bar (the Decoder), so
  // the Overview is opened with a real click to read the session it left behind.
  if ((await inPanel<CaptureCounts | null>(CAPTURE_COUNTS)) === null) {
    const scratch: TakeStep = { index: directions.steps.length, kind: 'click', label: 'check', start: now(), end: 0, waits: [] };
    const box = await resolveBox("css=nav[aria-label='Main sections'] >> text=Overview", scratch);
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: 'left', clickCount: 1 };
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, devtools);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at }, devtools);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at }, devtools);
  }
  const captureAtEnd = await waitPanel<CaptureCounts | null>(CAPTURE_COUNTS, (c) => c !== null, 10);
  // The Decoder never adds to the capture session: tokens and requests are exactly as before it.
  expect(captureAtEnd, 'capture counts after the Decoder scene').toEqual(capture);
  // A late HAR twin would be on screen in the last steps, so the count is checked once more.
  const countAtEnd = await inPanel<number>(REQUEST_COUNT);
  expect(countAtEnd, 'Bearer requests captured by the end of the take').toBe(expectedRequests);
  clearInterval(pump);
  await Promise.all(writes);
  expect(panelErrors, 'runtime errors in the TokenLens panel').toEqual([]);

  if (!CHECK) {
    frames.sort((a, b) => a[0] - b[0]);
    expect(frames.length, 'captured frames').toBeGreaterThan(100);
    const take = {
      version: 1,
      name: 'tokenlens-demo',
      recordedAt: new Date().toISOString(),
      platform: process.platform,
      target: { kind: 'web', url: 'http://app.example.test/' },
      width: W,
      height: H,
      scale,
      duration,
      cursorStart,
      source: { kind: 'frames', dir: 'frames', frames },
      steps,
    };
    await writeFile(join(TAKE_DIR, 'take.json'), JSON.stringify(take, null, 2));
    const fps = frames.length / duration;
    process.stdout.write(`take: ${frames.length} frames over ${duration.toFixed(1)} s (${fps.toFixed(1)} fps)\n`);
  }

  client.close();
  await context.close();
});
