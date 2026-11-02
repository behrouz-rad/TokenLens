import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureRelay, type DevtoolsNetworkApi } from '@/core/capture/relay';
import type { CaptureMessage, MessagePort } from '@/core/capture/channel';
import type { HarEntryLike } from '@/core/capture/observation';

function createFakeApi() {
  const requestListeners = new Set<(entry: HarEntryLike) => void>();
  const navigationListeners = new Set<(url: string) => void>();
  let harLog: HarEntryLike[] = [];
  let harCalls = 0;
  let failHar = false;
  const api: DevtoolsNetworkApi = {
    addRequestListener: (l) => requestListeners.add(l),
    removeRequestListener: (l) => requestListeners.delete(l),
    addNavigationListener: (l) => navigationListeners.add(l),
    removeNavigationListener: (l) => navigationListeners.delete(l),
    getHar: () => {
      harCalls += 1;
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

function setup(options: { harPollIntervalMs?: number } = {}) {
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
    now: () => 1000,
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

  it('picks up the HAR snapshot already recorded when it starts', async () => {
    const { fake, channel } = setup();
    fake.setHar([entry('1'), entry('2')]);
    await vi.advanceTimersByTimeAsync(100);
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
    await vi.advanceTimersByTimeAsync(1100);
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
