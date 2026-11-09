import type { MessagePort, CaptureMessage } from './channel';
import {
  harEntryKey,
  harEntryRequestIdentity,
  harEntryToObservation,
  isHarEntryInFlight,
  type CaptureObservation,
  type HarEntryLike,
  type UnsequencedRequestObservation,
} from './observation';

/** A completed request seen in one poll, kept sanitised (no headers besides the Bearer value). */
interface UnconfirmedRequest {
  observation: UnsequencedRequestObservation;
  identity: string;
  time: number | undefined;
}

export interface DevtoolsNetworkApi {
  addRequestListener(listener: (entry: HarEntryLike) => void): void;
  removeRequestListener(listener: (entry: HarEntryLike) => void): void;
  addNavigationListener(listener: (url: string) => void): void;
  removeNavigationListener(listener: (url: string) => void): void;
  getHar(): Promise<{ entries: HarEntryLike[] }>;
}

export interface RelayOptions {
  relayId: string;
  scope: string;
  port: MessagePort;
  api: DevtoolsNetworkApi;
  now?: () => number;
  /** Replay buffer size; bounds memory held by the DevTools page while no panel is open. */
  bufferSize?: number;
  /** Live observations are coalesced into one message per interval to keep the panel responsive during bursts. */
  flushIntervalMs?: number;
  /** Interval for the getHAR() reconciliation poll; see class comment. 0 disables polling. */
  harPollIntervalMs?: number;
  /** Poll less often once the HAR log is this large, because getHAR() serialises the whole log. */
  harPollSlowThreshold?: number;
  harPollSlowIntervalMs?: number;
  /** Bounded memory of request keys already emitted; protects against duplicate delivery between live events and polls. */
  seenKeyLimit?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Runs in the DevTools page, which exists for the whole life of a DevTools window, so capture
 * starts the moment DevTools opens rather than when the TokenLens tab is first shown. The panel
 * can mount, unmount, or reload as often as it likes and resynchronise from the replay buffer.
 *
 * Three browser limitations shape this class:
 *  - chrome.devtools.network only knows about traffic recorded after DevTools opened. Nothing
 *    earlier can be reconstructed.
 *  - In practice `onRequestFinished` is not delivered for every request DevTools records (observed
 *    in Chromium 156: requests made before the first navigation after DevTools opened never fire
 *    the event, although getHAR() returns them). The relay therefore reconciles against getHAR()
 *    on a timer and treats the two sources as one stream, de-duplicated by request key.
 *  - getHAR() also lists requests that have not finished: in flight (no status, no duration) and,
 *    briefly, with a response whose loading has not finished (its duration still changes). In-flight
 *    entries are skipped until they complete or fail. A completed entry first seen in a poll is
 *    emitted once onRequestFinished delivers it or a later poll reports it unchanged, so each
 *    request is emitted once, with its final values. A request can still fail after that first
 *    sighting (a dropped connection, a cancellation); its failure is reported under a new key, and
 *    the earlier snapshot is discarded because the request is still in the log.
 *
 * Clear is a boundary in time: a request that started before the relay received `clear` belongs to
 * the cleared session and is never emitted afterwards, whether it was awaiting confirmation, still
 * in flight, returned by a getHAR() call that overlapped the Clear or delivered live later. Request
 * keys cannot express this, because an in-flight request has no stable key before it finishes.
 */
export class CaptureRelay {
  private readonly buffer: CaptureObservation[] = [];
  private readonly outbox: CaptureObservation[] = [];
  private readonly seenKeys = new Set<string>();
  private readonly seenKeyOrder: string[] = [];
  /** Completed requests seen in one poll, waiting for onRequestFinished or an unchanged next poll. */
  private readonly unconfirmed = new Map<string, UnconfirmedRequest>();
  /** Requests that started before this time were cleared by the user (see the class comment). */
  private clearedAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly bufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly harPollIntervalMs: number;
  private readonly harPollSlowThreshold: number;
  private readonly harPollSlowIntervalMs: number;
  private readonly seenKeyLimit: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private seq = 0;
  private started = false;
  private polling = false;
  private flushHandle: unknown = null;
  private pollHandle: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private liveEventCount = 0;
  private polledEntryCount = 0;

  private readonly onRequestFinished = (entry: HarEntryLike): void => {
    this.liveEventCount += 1;
    this.admit(entry);
  };

  private readonly onNavigated = (url: string): void => {
    this.enqueue({ kind: 'navigation', relayId: this.options.relayId, seq: ++this.seq, url, at: this.now() });
    this.schedulePoll(0);
  };

  constructor(private readonly options: RelayOptions) {
    this.now = options.now ?? (() => Date.now());
    this.bufferSize = options.bufferSize ?? 5000;
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.harPollIntervalMs = options.harPollIntervalMs ?? 1000;
    this.harPollSlowThreshold = options.harPollSlowThreshold ?? 2000;
    this.harPollSlowIntervalMs = options.harPollSlowIntervalMs ?? 5000;
    this.seenKeyLimit = options.seenKeyLimit ?? 20_000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.api.addRequestListener(this.onRequestFinished);
    this.options.api.addNavigationListener(this.onNavigated);
    this.unsubscribe = this.options.port.onMessage(this.handleMessage);
    this.schedulePoll(0);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.options.api.removeRequestListener(this.onRequestFinished);
    this.options.api.removeNavigationListener(this.onNavigated);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.flushHandle !== null) {
      this.clearTimer(this.flushHandle);
      this.flushHandle = null;
    }
    if (this.pollHandle !== null) {
      this.clearTimer(this.pollHandle);
      this.pollHandle = null;
    }
    this.flush();
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  get stats(): { liveEvents: number; polledEntries: number; emitted: number } {
    return { liveEvents: this.liveEventCount, polledEntries: this.polledEntryCount, emitted: this.seq };
  }

  /** Emits the entry unless an identical request key was already emitted (live or polled). */
  private admit(entry: HarEntryLike): boolean {
    return this.emit(harEntryKey(entry), harEntryToObservation(entry, this.now()));
  }

  /** Emits a request once per key; a request from before the last Clear is remembered, not emitted. */
  private emit(key: string, observation: UnsequencedRequestObservation): boolean {
    this.unconfirmed.delete(key);
    if (this.seenKeys.has(key)) return false;
    this.remember(key);
    if (observation.startedAt < this.clearedAt) return false;
    this.enqueue({ ...observation, relayId: this.options.relayId, seq: ++this.seq });
    return true;
  }

  private remember(key: string): void {
    this.seenKeys.add(key);
    this.seenKeyOrder.push(key);
    if (this.seenKeyOrder.length > this.seenKeyLimit) {
      const oldest = this.seenKeyOrder.splice(0, this.seenKeyOrder.length - this.seenKeyLimit);
      for (const k of oldest) this.seenKeys.delete(k);
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.started || this.harPollIntervalMs <= 0) return;
    if (this.pollHandle !== null) this.clearTimer(this.pollHandle);
    this.pollHandle = this.setTimer(() => {
      this.pollHandle = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.started || this.polling) return;
    this.polling = true;
    // A failed call says nothing about the log, so it must not look like an emptied one.
    const entries = await this.options.api
      .getHar()
      .then((log) => (Array.isArray(log.entries) ? log.entries : []))
      .catch((): null => null);
    this.polling = false;
    if (!this.started) return;
    if (entries) this.reconcile(entries);
    const slow = (entries?.length ?? 0) >= this.harPollSlowThreshold;
    this.schedulePoll(slow ? this.harPollSlowIntervalMs : this.harPollIntervalMs);
  }

  /** Emits each polled request once it is final; see the class comment for the snapshot stages. */
  private reconcile(entries: readonly HarEntryLike[]): void {
    const listed = new Set<string>();
    const present = new Set<string>();
    for (const entry of entries) {
      present.add(harEntryRequestIdentity(entry));
      if (isHarEntryInFlight(entry)) continue;
      const key = harEntryKey(entry);
      listed.add(key);
      if (this.seenKeys.has(key)) continue;
      const observation = harEntryToObservation(entry, this.now());
      if (observation.startedAt < this.clearedAt) {
        this.remember(key);
        continue;
      }
      const earlier = this.unconfirmed.get(key);
      // A failure is final when first reported; a response is final once its duration stops changing.
      if (entry.response?._error || (earlier !== undefined && earlier.time === entry.time)) {
        if (this.emit(key, observation)) this.polledEntryCount += 1;
      } else {
        this.unconfirmed.set(key, { observation, identity: harEntryRequestIdentity(entry), time: entry.time });
      }
    }
    for (const [key, pending] of this.unconfirmed) {
      if (listed.has(key)) continue;
      this.unconfirmed.delete(key);
      // Still in the log under another key: the request moved on (it failed after its headers, for
      // example) and its later snapshot is reported on its own.
      if (present.has(pending.identity)) continue;
      // Gone from the log (cleared on navigation) and never reported again: emit the last snapshot rather than lose the request.
      if (this.emit(key, pending.observation)) this.polledEntryCount += 1;
    }
  }

  private enqueue(observation: CaptureObservation): void {
    this.buffer.push(observation);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    this.outbox.push(observation);
    if (this.flushHandle === null) {
      this.flushHandle = this.setTimer(() => {
        this.flushHandle = null;
        this.flush();
      }, this.flushIntervalMs);
    }
  }

  private flush(): void {
    if (this.outbox.length === 0) return;
    const observations = this.outbox.splice(0, this.outbox.length);
    this.options.port.postMessage({
      type: 'observations',
      from: 'relay',
      relayId: this.options.relayId,
      scope: this.options.scope,
      observations,
    });
  }

  private readonly handleMessage = (message: CaptureMessage): void => {
    if (message.type === 'clear') {
      // Keys stay remembered so already-seen requests are not re-emitted, and every request that
      // started before now is withheld however it is reported later (see the class comment).
      this.clearedAt = Math.max(this.clearedAt, this.now());
      this.buffer.length = 0;
      this.outbox.length = 0;
      this.unconfirmed.clear();
      return;
    }
    if (message.type !== 'hello') return;
    this.flush();
    this.options.port.postMessage({
      type: 'snapshot',
      from: 'relay',
      relayId: this.options.relayId,
      scope: this.options.scope,
      observations: [...this.buffer],
    });
    this.schedulePoll(0);
  };
}

export function createChromeNetworkApi(network: typeof chrome.devtools.network): DevtoolsNetworkApi {
  return {
    addRequestListener: (listener) => network.onRequestFinished.addListener(listener),
    removeRequestListener: (listener) => network.onRequestFinished.removeListener(listener),
    addNavigationListener: (listener) => network.onNavigated.addListener(listener),
    removeNavigationListener: (listener) => network.onNavigated.removeListener(listener),
    getHar: () =>
      new Promise((resolve) => {
        network.getHAR((log) => resolve({ entries: log.entries ?? [] }));
      }),
  };
}

export function createRelayId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
