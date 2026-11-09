import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureRelay, type DevtoolsNetworkApi } from '@/core/capture/relay';
import type { CaptureMessage, MessagePort } from '@/core/capture/channel';
import type { HarEntryLike } from '@/core/capture/observation';
import { createCaptureState, eventsForToken, ingestObservations, verifyReferentialIntegrity } from '@/core/capture/session';
import { createSyntheticJwt } from '@/core/testing/synthetic';

function createFakeApi() {
  const requestListeners = new Set<(entry: HarEntryLike) => void>();
  const navigationListeners = new Set<(url: string) => void>();
  let harLog: HarEntryLike[] = [];
  let harCalls = 0;
  let failHar = false;
  let heldHar: ((entries: HarEntryLike[]) => void) | null = null;
  let holdNext = false;
  const api: DevtoolsNetworkApi = {
    addRequestListener: (l) => requestListeners.add(l),
    removeRequestListener: (l) => requestListeners.delete(l),
    addNavigationListener: (l) => navigationListeners.add(l),
    removeNavigationListener: (l) => navigationListeners.delete(l),
    getHar: () => {
      harCalls += 1;
      if (holdNext) {
        holdNext = false;
        return new Promise((resolve) => {
          heldHar = (entries) => resolve({ entries });
        });
      }
      return failHar ? Promise.reject(new Error('boom')) : Promise.resolve({ entries: [...harLog] });
    },
  };
  return {
    api,
    requestListeners,
    navigationListeners,
    emitRequest: (entry: HarEntryLike) => requestListeners.forEach((l) => l(entry)),
    emitNavigation: (url: string) => navigationListeners.forEach((l) => l(url)),
    setHar: (entries: HarEntryLike[]) => {
      harLog = entries;
    },
    get harCalls() {
      return harCalls;
    },
    set failHar(value: boolean) {
      failHar = value;
    },
    /** The next getHAR() call stays pending until `releaseHar` answers it. */
    holdNextHar: () => {
      holdNext = true;
    },
    releaseHar: (entries: HarEntryLike[]) => {
      heldHar?.(entries);
      heldHar = null;
    },
  };
}

function createFakePort() {
  const handlers = new Set<(message: CaptureMessage) => void>();
  const sent: CaptureMessage[] = [];
  const port: MessagePort = {
    postMessage: (message) => {
      sent.push(message);
    },
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close: () => {},
  };
  return { port, sent, receive: (message: CaptureMessage) => handlers.forEach((h) => h(message)) };
}

let counter = 0;
function entry(id: string, overrides: Partial<HarEntryLike> = {}): HarEntryLike {
  counter += 1;
  return {
    startedDateTime: new Date(1_700_000_000_000 + counter).toISOString(),
    time: 10 + counter / 1000,
    _connectionId: String(1000 + counter),
    request: { method: 'GET', url: `https://api.example.test/${id}`, headers: [{ name: 'Authorization', value: 'Bearer t' }] },
    response: { status: 200, statusText: 'OK' },
    ...overrides,
  };
}

function setup(options: { harPollIntervalMs?: number; now?: () => number } = {}) {
  vi.useFakeTimers();
  const fake = createFakeApi();
  const channel = createFakePort();
  const relay = new CaptureRelay({
    relayId: 'relay-1',
    scope: '7',
    port: channel.port,
    api: fake.api,
    flushIntervalMs: 50,
    bufferSize: 5,
    harPollIntervalMs: options.harPollIntervalMs ?? 1000,
    now: options.now ?? (() => 1000),
  });
  relay.start();
  return { relay, fake, channel };
}

const observationsOf = (sent: CaptureMessage[]) => sent.flatMap((m) => (m.type === 'observations' || m.type === 'snapshot' ? m.observations : []));
const urlsOf = (sent: CaptureMessage[]) => observationsOf(sent).map((o) => (o.kind === 'request' ? o.url.split('/').pop() : o.kind));

afterEach(() => {
  vi.useRealTimers();
});

describe('CaptureRelay', () => {
  it('registers listeners once and removes them on stop', () => {
    const { relay, fake } = setup();
    relay.start();
    expect(fake.requestListeners.size).toBe(1);
    expect(fake.navigationListeners.size).toBe(1);
    relay.stop();
    expect(fake.requestListeners.size).toBe(0);
    expect(fake.navigationListeners.size).toBe(0);
  });

  it('picks up the HAR snapshot already recorded when it starts, once a second poll confirms it', async () => {
    const { fake, channel } = setup();
    fake.setHar([entry('1'), entry('2')]);
    await vi.advanceTimersByTimeAsync(100);
    expect(urlsOf(channel.sent)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(urlsOf(channel.sent)).toEqual(['1', '2']);
    expect(observationsOf(channel.sent).map((o) => o.seq)).toEqual([1, 2]);
  });

  it('merges live events and polled HAR entries into one de-duplicated stream', async () => {
    const { fake, channel, relay } = setup();
    await vi.advanceTimersByTimeAsync(10);
    const a = entry('a');
    const b = entry('b');
    fake.emitRequest(a);
    fake.setHar([a, b]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(urlsOf(channel.sent)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(urlsOf(channel.sent)).toEqual(['a', 'b']);
    fake.emitRequest(b);
    await vi.advanceTimersByTimeAsync(100);
    expect(urlsOf(channel.sent)).toEqual(['a', 'b']);
    expect(relay.stats).toMatchObject({ liveEvents: 2, polledEntries: 1, emitted: 2 });
  });

  it('keeps distinct requests that share method, URL and token as separate observations', async () => {
    const { fake, channel } = setup();
    await vi.advanceTimersByTimeAsync(10);
    fake.emitRequest(entry('same', { request: { method: 'GET', url: 'https://api.example.test/same', headers: [] } }));
    fake.emitRequest(entry('same', { request: { method: 'GET', url: 'https://api.example.test/same', headers: [] } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(observationsOf(channel.sent)).toHaveLength(2);
  });

  it('polls faster while the log is small and backs off once it is large', async () => {
    const { fake } = setup();
    await vi.advanceTimersByTimeAsync(10);
    const before = fake.harCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.harCalls - before).toBe(3);
    fake.setHar(Array.from({ length: 2500 }, (_, i) => entry(`big-${i}`)));
    await vi.advanceTimersByTimeAsync(1000);
    const afterBig = fake.harCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.harCalls - afterBig).toBeLessThanOrEqual(1);
  });

  it('batches live events into one message per flush interval', async () => {
    const { fake, channel } = setup();
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 10; i++) fake.emitRequest(entry(`l${i}`));
    expect(channel.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({ type: 'observations', relayId: 'relay-1', scope: '7' });
    expect(observationsOf(channel.sent)).toHaveLength(10);
  });

  it('replays a bounded buffer when a panel says hello and re-polls immediately', async () => {
    const { fake, channel, relay } = setup();
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 8; i++) fake.emitRequest(entry(`r${i}`));
    await vi.advanceTimersByTimeAsync(60);
    const calls = fake.harCalls;
    channel.receive({ type: 'hello', from: 'panel', scope: '7' });
    const snapshot = channel.sent.find((m) => m.type === 'snapshot');
    expect(snapshot?.type).toBe('snapshot');
    if (snapshot?.type !== 'snapshot') return;
    expect(snapshot.observations.map((o) => o.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(relay.bufferedCount).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.harCalls).toBe(calls + 1);
  });

  it('flushes pending observations before answering hello so ordering is preserved', async () => {
    const { fake, channel } = setup();
    await vi.advanceTimersByTimeAsync(10);
    fake.emitRequest(entry('a'));
    channel.receive({ type: 'hello', from: 'panel', scope: '7' });
    expect(channel.sent.map((m) => m.type)).toEqual(['observations', 'snapshot']);
  });

  it('emits navigation observations and re-polls after navigation', async () => {
    const { fake, channel } = setup();
    await vi.advanceTimersByTimeAsync(10);
    const calls = fake.harCalls;
    fake.emitNavigation('https://app.example.test/next');
    await vi.advanceTimersByTimeAsync(60);
    expect(observationsOf(channel.sent)).toEqual([{ kind: 'navigation', relayId: 'relay-1', seq: 1, url: 'https://app.example.test/next', at: 1000 }]);
    expect(fake.harCalls).toBeGreaterThan(calls);
  });

  it('continues when getHAR fails', async () => {
    const { fake, channel } = setup();
    fake.failHar = true;
    await vi.advanceTimersByTimeAsync(10);
    fake.emitRequest(entry('after'));
    await vi.advanceTimersByTimeAsync(60);
    expect(observationsOf(channel.sent)).toHaveLength(1);
    fake.failHar = false;
    fake.setHar([entry('later')]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(observationsOf(channel.sent)).toHaveLength(2);
  });

  it('drops the replay buffer on clear but never re-emits requests it has already seen', async () => {
    const { fake, channel, relay } = setup();
    await vi.advanceTimersByTimeAsync(10);
    const a = entry('a');
    fake.emitRequest(a);
    await vi.advanceTimersByTimeAsync(60);
    expect(relay.bufferedCount).toBe(1);
    channel.receive({ type: 'clear', from: 'panel', scope: '7' });
    expect(relay.bufferedCount).toBe(0);
    channel.receive({ type: 'hello', from: 'panel', scope: '7' });
    const snapshot = channel.sent.find((m) => m.type === 'snapshot');
    expect(snapshot?.type === 'snapshot' && snapshot.observations).toEqual([]);
    fake.setHar([a]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(observationsOf(channel.sent)).toHaveLength(1);
  });

  it('stops polling after stop()', async () => {
    const { fake, relay } = setup();
    await vi.advanceTimersByTimeAsync(10);
    relay.stop();
    const calls = fake.harCalls;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.harCalls).toBe(calls);
  });
});

/**
 * Snapshots of one request as Chromium's getHAR() reports it over its life, shaped after a real
 * DevTools capture: while in flight it has no status, duration or error; once the response
 * headers arrive it is reported complete, but `timings.receive` (and so `time`) keeps changing
 * until loading finishes; onRequestFinished then delivers the final values. Failures carry
 * `response._error` and a final duration. A request that fails after its headers either keeps
 * status, connection and settled phases (a dropped connection, `failedAfterHeaders`) or is
 * reported like a request that never got a response (a cancellation, `failed`).
 */
function lifecycle(path: string, options: { started?: number; blocked?: number; status?: number; token?: string } = {}) {
  const startedDateTime = new Date(options.started ?? 1_700_000_500_000).toISOString();
  const request = { method: 'GET', url: `https://api.example.test/${path}`, headers: [{ name: 'Authorization', value: `Bearer ${options.token ?? 't'}` }] };
  const blocked = options.blocked ?? 44.78;
  const status = options.status ?? 200;
  const completed = (receive: number): HarEntryLike => ({
    startedDateTime,
    time: blocked + 0.08 + 12.65 + receive,
    _connectionId: '137',
    request,
    response: { status, statusText: status === 200 ? 'OK' : 'Unauthorized', _error: null },
    timings: { blocked, _blocked_queueing: blocked - 0.5, dns: -1, connect: -1, ssl: -1, send: 0.08, wait: 12.65, receive },
  });
  const failedAfterHeaders = (error: string, time: number): HarEntryLike => ({
    ...completed(time - blocked - 0.08 - 12.65),
    time,
    response: { status, statusText: 'OK', _error: error },
  });
  const failed = (error: string, time: number, responseStatus = 0): HarEntryLike => ({
    startedDateTime,
    time,
    request,
    response: { status: responseStatus, statusText: '', _error: error },
    timings: { blocked: 0, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 },
  });
  const inFlight: HarEntryLike = {
    startedDateTime,
    time: 0,
    request,
    response: { status: 0, statusText: '', _error: null },
    timings: { blocked: -122_866_531.05, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 },
  };
  const early = completed(1.89);
  const final = completed(0.55);
  return { inFlight, early, final, failed, failedAfterHeaders, earlyTime: early.time ?? 0, finalTime: final.time ?? 0 };
}

describe('CaptureRelay reconciles each request across its getHAR() snapshots', () => {
  const requestsOf = (sent: CaptureMessage[]) => observationsOf(sent).flatMap((o) => (o.kind === 'request' ? [o] : []));

  async function started() {
    const ctx = setup();
    // Half an interval in, so each step below contains exactly one poll and the flush after it.
    await vi.advanceTimersByTimeAsync(500);
    const poll = async (entries: HarEntryLike[]) => {
      ctx.fake.setHar(entries);
      await vi.advanceTimersByTimeAsync(1000);
    };
    const live = async (e: HarEntryLike) => {
      ctx.fake.emitRequest(e);
      await vi.advanceTimersByTimeAsync(60);
    };
    return { ...ctx, poll, live };
  }

  it('reports nothing while getHAR() still shows the request in flight, however often it polls', async () => {
    const { channel, poll, live } = await started();
    const r = lifecycle('slow');
    for (let i = 0; i < 4; i++) await poll([r.inFlight]);
    expect(requestsOf(channel.sent)).toEqual([]);
    await live(r.final);
    await poll([r.final]);
    expect(requestsOf(channel.sent)).toEqual([expect.objectContaining({ status: 200, durationMs: r.finalTime, bearerToken: 't' })]);
  });

  it('in flight, then completed in getHAR() only: one request with the final values', async () => {
    const { channel, poll } = await started();
    const r = lifecycle('poll-only');
    await poll([r.inFlight]);
    await poll([r.early]);
    await poll([r.final]);
    expect(requestsOf(channel.sent)).toEqual([]);
    await poll([r.final]);
    await poll([r.final]);
    expect(requestsOf(channel.sent)).toEqual([expect.objectContaining({ status: 200, durationMs: r.finalTime })]);
  });

  it('completed early in getHAR(), then onRequestFinished: the final values win and nothing repeats', async () => {
    const { channel, poll, live } = await started();
    const r = lifecycle('early-then-live');
    await poll([r.inFlight]);
    await poll([r.early]);
    await live(r.final);
    await poll([r.final]);
    await poll([r.final]);
    expect(requestsOf(channel.sent)).toEqual([expect.objectContaining({ durationMs: r.finalTime })]);
  });

  it('onRequestFinished first, then getHAR(): no second request', async () => {
    const { channel, poll, live } = await started();
    const r = lifecycle('live-first');
    await live(r.final);
    await poll([r.final]);
    await poll([r.final]);
    expect(requestsOf(channel.sent)).toHaveLength(1);
  });

  it('keeps genuinely failed and cancelled requests exactly once, whichever source reports them first', async () => {
    const { channel, poll, live } = await started();
    const refused = lifecycle('refused', { started: 1_700_000_600_000 }).failed('net::ERR_CONNECTION_REFUSED', 6.2);
    const abortedRequest = lifecycle('aborted', { started: 1_700_000_700_000 });
    const aborted = abortedRequest.failed('net::ERR_ABORTED', 702.9);
    const corsBlocked = lifecycle('cors', { started: 1_700_000_800_000 }).failed('net::ERR_FAILED', 82.9, 200);
    await poll([refused, abortedRequest.inFlight]);
    await live(refused);
    await live(corsBlocked);
    await poll([refused, aborted, corsBlocked]);
    await live(aborted);
    await poll([refused, aborted, corsBlocked]);
    expect(requestsOf(channel.sent).map((o) => [o.url.split('/').pop(), o.status, o.durationMs])).toEqual([
      ['refused', 0, 6.2],
      ['cors', 200, 82.9],
      ['aborted', 0, 702.9],
    ]);
  });

  it('keeps distinct failures of the same URL in the same millisecond apart', async () => {
    const { channel, poll } = await started();
    const r = lifecycle('refused-twice');
    await poll([r.failed('net::ERR_CONNECTION_REFUSED', 6.2), r.failed('net::ERR_CONNECTION_REFUSED', 7.9)]);
    expect(requestsOf(channel.sent)).toHaveLength(2);
  });

  it('keeps requests that share URL, token and start millisecond distinct through every stage', async () => {
    const { channel, poll, live } = await started();
    const a = lifecycle('same', { blocked: 44.78 });
    const b = lifecycle('same', { blocked: 58.11 });
    await poll([a.inFlight, b.inFlight]);
    await poll([a.early, b.inFlight]);
    await live(a.final);
    await poll([a.final, b.early]);
    await poll([a.final, b.final]);
    await poll([a.final, b.final]);
    await live(b.final);
    expect(requestsOf(channel.sent).map((o) => o.durationMs)).toEqual([a.finalTime, b.finalTime]);
  });

  it('still reports a completed request whose entry leaves the log before it is confirmed', async () => {
    const { channel, poll } = await started();
    const r = lifecycle('cleared');
    await poll([r.early]);
    await poll([]);
    await poll([]);
    expect(requestsOf(channel.sent)).toEqual([expect.objectContaining({ durationMs: r.earlyTime })]);
  });

  it('does not treat a failed getHAR() call as the request leaving the log', async () => {
    const { channel, fake, poll } = await started();
    const r = lifecycle('har-failure');
    await poll([r.early]);
    fake.failHar = true;
    await poll([]);
    fake.failHar = false;
    await poll([r.final]);
    await poll([r.final]);
    expect(requestsOf(channel.sent)).toEqual([expect.objectContaining({ durationMs: r.finalTime })]);
  });

  it('gives the session exactly one request, token link and timeline event per request', async () => {
    const { channel, poll, live } = await started();
    const token = createSyntheticJwt({ alg: 'RS256' }, { sub: 'lifecycle', exp: 1_800_000_000 });
    const ok = lifecycle('orders', { token, started: 1_700_000_900_000 });
    const rejected = lifecycle('invoices', { token, status: 401, started: 1_700_000_901_000 });
    await poll([ok.inFlight, rejected.inFlight]);
    await poll([ok.early, rejected.inFlight]);
    await live(ok.final);
    await poll([ok.final, rejected.early]);
    await live(rejected.final);
    await poll([ok.final, rejected.final]);
    await poll([ok.final, rejected.final]);

    const state = ingestObservations(createCaptureState(), observationsOf(channel.sent), { now: 1_700_001_000_000, recording: true, clearOnNavigation: false });
    expect(verifyReferentialIntegrity(state)).toEqual([]);
    expect(state.tokens.size).toBe(1);
    expect(state.requests.size).toBe(2);
    expect(state.counters.observedRequests).toBe(2);
    expect([...state.requests.values()].map((r) => [r.url.split('/').pop(), r.status, r.durationMs])).toEqual([
      ['orders', 200, ok.finalTime],
      ['invoices', 401, rejected.finalTime],
    ]);
    const [record] = [...state.tokens.values()];
    expect(record?.requestIds).toHaveLength(2);
    const observed = eventsForToken(state, record!.id).filter((e) => e.requestId !== undefined);
    expect(observed.map((e) => e.type).sort()).toEqual(['failed-request', 'used-in-request']);
  });
});

describe('CaptureRelay keeps one observation when a request fails after its response headers', () => {
  const requestsOf = (sent: CaptureMessage[]) => observationsOf(sent).flatMap((o) => (o.kind === 'request' ? [o] : []));

  async function started() {
    const ctx = setup();
    await vi.advanceTimersByTimeAsync(500);
    const poll = async (entries: HarEntryLike[]) => {
      ctx.fake.setHar(entries);
      await vi.advanceTimersByTimeAsync(1000);
    };
    const live = async (e: HarEntryLike) => {
      ctx.fake.emitRequest(e);
      await vi.advanceTimersByTimeAsync(60);
    };
    return { ...ctx, poll, live };
  }

  it('connection dropped while the body loads, reported live first', async () => {
    const { channel, poll, live } = await started();
    const r = lifecycle('dropped');
    const terminal = r.failedAfterHeaders('net::ERR_INCOMPLETE_CHUNKED_ENCODING', 939.3);
    await poll([r.early]);
    await live(terminal);
    for (let i = 0; i < 3; i++) await poll([terminal]);
    expect(requestsOf(channel.sent).map((o) => [o.status, o.durationMs])).toEqual([[200, 939.3]]);
  });

  it('connection dropped while the body loads, seen in getHAR() first', async () => {
    const { channel, poll, live } = await started();
    const r = lifecycle('dropped-polled');
    const terminal = r.failedAfterHeaders('net::ERR_INCOMPLETE_CHUNKED_ENCODING', 939.3);
    await poll([r.early]);
    await poll([terminal]);
    await live(terminal);
    for (let i = 0; i < 3; i++) await poll([terminal]);
    expect(requestsOf(channel.sent).map((o) => [o.status, o.durationMs])).toEqual([[200, 939.3]]);
  });

  it('cancelled while the body loads, reported as a request without a response, in either order', async () => {
    const { channel, poll, live } = await started();
    const first = lifecycle('cancelled-live', { started: 1_700_000_510_000 });
    const second = lifecycle('cancelled-polled', { started: 1_700_000_520_000 });
    const firstEnd = first.failed('net::ERR_ABORTED', 913.7);
    const secondEnd = second.failed('net::ERR_ABORTED', 702.4);
    await poll([first.early, second.early]);
    await live(firstEnd);
    await poll([firstEnd, secondEnd]);
    await live(secondEnd);
    for (let i = 0; i < 3; i++) await poll([firstEnd, secondEnd]);
    expect(requestsOf(channel.sent).map((o) => [o.url.split('/').pop(), o.status, o.durationMs])).toEqual([
      ['cancelled-live', 0, 913.7],
      ['cancelled-polled', 0, 702.4],
    ]);
  });

  it('keeps concurrent requests with the same URL, token and start millisecond distinct when one fails', async () => {
    const { channel, poll, live } = await started();
    const a = lifecycle('twin', { blocked: 44.78 });
    const b = lifecycle('twin', { blocked: 58.11 });
    const aEnd = a.failed('net::ERR_ABORTED', 700.2);
    await poll([a.early, b.early]);
    await poll([aEnd, b.final]);
    await poll([aEnd, b.final]);
    await live(aEnd);
    await live(b.final);
    await poll([aEnd, b.final]);
    expect(requestsOf(channel.sent).map((o) => [o.status, o.durationMs])).toEqual([
      [0, 700.2],
      [200, b.finalTime],
    ]);
  });
});

describe('CaptureRelay Clear', () => {
  const requestsOf = (sent: CaptureMessage[]) => observationsOf(sent).flatMap((o) => (o.kind === 'request' ? [o] : []));
  /** Requests in these tests start at 1_700_000_500_000; Clear happens two seconds later. */
  const CLEAR_AT = 1_700_000_502_000;

  async function started() {
    const ctx = setup({ now: () => Date.now() });
    vi.setSystemTime(CLEAR_AT - 1500);
    await vi.advanceTimersByTimeAsync(500);
    const poll = async (entries: HarEntryLike[]) => {
      ctx.fake.setHar(entries);
      await vi.advanceTimersByTimeAsync(1000);
    };
    const live = async (e: HarEntryLike) => {
      ctx.fake.emitRequest(e);
      await vi.advanceTimersByTimeAsync(60);
    };
    const clear = () => {
      vi.setSystemTime(CLEAR_AT);
      ctx.channel.receive({ type: 'clear', from: 'panel', scope: '7' });
    };
    return { ...ctx, poll, live, clear };
  }

  it('never lets a request awaiting confirmation reappear after Clear', async () => {
    const { channel, poll, live, clear } = await started();
    const r = lifecycle('pending');
    await poll([r.early]);
    clear();
    await poll([r.early]);
    await poll([r.final]);
    await poll([r.final]);
    await live(r.final);
    await poll([r.final]);
    expect(requestsOf(channel.sent)).toEqual([]);
  });

  it('does not capture a request that was in flight at Clear when it completes or fails later', async () => {
    const { channel, poll, live, clear } = await started();
    const done = lifecycle('in-flight-done');
    const cancelled = lifecycle('in-flight-cancelled');
    await poll([done.inFlight, cancelled.inFlight]);
    clear();
    await live(done.final);
    await poll([done.final, cancelled.failed('net::ERR_ABORTED', 2300)]);
    await poll([done.final, cancelled.failed('net::ERR_ABORTED', 2300)]);
    expect(requestsOf(channel.sent)).toEqual([]);
  });

  it('treats a getHAR() call that was answered after Clear as pre-Clear state', async () => {
    const { channel, fake, poll, clear } = await started();
    const r = lifecycle('overlap');
    fake.holdNextHar();
    await vi.advanceTimersByTimeAsync(1000);
    clear();
    fake.releaseHar([r.final, lifecycle('overlap-failed').failed('net::ERR_CONNECTION_REFUSED', 6.2)]);
    await vi.advanceTimersByTimeAsync(1000);
    await poll([r.final]);
    expect(requestsOf(channel.sent)).toEqual([]);
  });

  it('replays nothing from before Clear', async () => {
    const { channel, live, clear } = await started();
    await live(lifecycle('emitted').final);
    clear();
    channel.receive({ type: 'hello', from: 'panel', scope: '7' });
    const snapshot = channel.sent.find((m) => m.type === 'snapshot');
    expect(snapshot?.type === 'snapshot' && snapshot.observations).toEqual([]);
  });

  it('captures a request that starts after Clear exactly once', async () => {
    const { channel, poll, live, clear } = await started();
    const before = lifecycle('before');
    await poll([before.early]);
    clear();
    const after = lifecycle('after', { started: CLEAR_AT + 300 });
    await poll([before.final, after.inFlight]);
    await poll([before.final, after.early]);
    await live(after.final);
    await poll([before.final, after.final]);
    await poll([before.final, after.final]);
    expect(requestsOf(channel.sent).map((o) => [o.url.split('/').pop(), o.durationMs])).toEqual([['after', after.finalTime]]);
  });
});
