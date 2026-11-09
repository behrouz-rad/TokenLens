/**
 * Observations are the only thing that crosses from the DevTools page (where
 * chrome.devtools.network events arrive) to the panel. They carry just the metadata TokenLens
 * needs plus the Bearer credential itself; all other request and response headers are dropped
 * at the boundary so cookies and unrelated secrets are never retained.
 */
export interface RequestObservation {
  kind: 'request';
  relayId: string;
  seq: number;
  url: string;
  method: string;
  status: number;
  statusText: string;
  startedAt: number;
  durationMs: number;
  bearerToken: string | null;
  authorizationScheme: 'bearer' | 'other' | null;
}

export interface NavigationObservation {
  kind: 'navigation';
  relayId: string;
  seq: number;
  url: string;
  at: number;
}

export type CaptureObservation = RequestObservation | NavigationObservation;

export type UnsequencedRequestObservation = Omit<RequestObservation, 'relayId' | 'seq'>;

export interface HarHeaderLike {
  name: string;
  value: string;
}

/** Structural subset of a HAR entry; chrome.devtools.network.Request satisfies it. */
export interface HarEntryLike {
  startedDateTime?: string;
  time?: number;
  connection?: string;
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeaderLike[];
  };
  response?: {
    status?: number;
    statusText?: string;
    /** Chrome's network error for a request that failed or was cancelled (e.g. `net::ERR_ABORTED`). */
    _error?: string | null;
  };
  timings?: Partial<Record<'blocked' | '_blocked_queueing' | 'dns' | 'connect' | 'ssl' | 'send' | 'wait' | 'receive', number>>;
  _requestId?: unknown;
  _connectionId?: unknown;
}

export interface AuthorizationExtraction {
  scheme: 'bearer' | 'other' | null;
  bearerToken: string | null;
}

const BEARER_PATTERN = /^\s*Bearer\s+(\S+)\s*$/i;

export function extractAuthorization(headers: readonly HarHeaderLike[] | undefined): AuthorizationExtraction {
  if (!headers) return { scheme: null, bearerToken: null };
  const header = headers.find((h) => typeof h.name === 'string' && h.name.toLowerCase() === 'authorization');
  if (!header || typeof header.value !== 'string') return { scheme: null, bearerToken: null };
  const match = BEARER_PATTERN.exec(header.value);
  if (match?.[1]) return { scheme: 'bearer', bearerToken: match[1] };
  if (header.value.trim().length === 0) return { scheme: null, bearerToken: null };
  return { scheme: 'other', bearerToken: null };
}

export function harEntryToObservation(entry: HarEntryLike, receivedAt: number): UnsequencedRequestObservation {
  const started = entry.startedDateTime ? Date.parse(entry.startedDateTime) : Number.NaN;
  const time = typeof entry.time === 'number' && Number.isFinite(entry.time) && entry.time >= 0 ? entry.time : 0;
  const status = typeof entry.response?.status === 'number' ? entry.response.status : 0;
  const { scheme, bearerToken } = extractAuthorization(entry.request?.headers);

  return {
    kind: 'request',
    url: typeof entry.request?.url === 'string' ? entry.request.url : '',
    method: (entry.request?.method ?? 'GET').toUpperCase(),
    status,
    statusText: entry.response?.statusText ?? '',
    startedAt: Number.isFinite(started) ? started : receivedAt,
    durationMs: time,
    bearerToken,
    authorizationScheme: scheme,
  };
}

/**
 * True while getHAR() reports a request that has neither a response nor a failure yet: Chrome
 * lists in-flight requests with status 0, no duration and no `_error`. A request that failed or
 * was cancelled also has status 0 but always carries `_error`, so it is never mistaken for one.
 */
export function isHarEntryInFlight(entry: HarEntryLike): boolean {
  return (entry.response?.status ?? 0) === 0 && !entry.response?._error;
}

/** Timing phases that are fixed once the response headers have arrived; `receive` is not. */
const SETTLED_PHASES = ['blocked', '_blocked_queueing', 'dns', 'connect', 'ssl', 'send', 'wait'] as const;

/**
 * Request identity used to reconcile live `onRequestFinished` events with getHAR() polls, which
 * report the same requests. Chrome's HAR entries carry no stable request id, so the key combines
 * start time (millisecond precision), connection id, method, URL, status and error with
 * sub-millisecond timings. It must not change while a request finishes: getHAR() can report a
 * response before loading has finished, and until then `timings.receive`, and so `time`, still
 * change. The key therefore uses the phases that are already settled; a failure is terminal, so
 * its total time is used. Two genuinely distinct requests collide only if every one of those
 * matches, which would hide one request from the inventory; it can never merge requests that
 * differ in any field. Not meaningful for in-flight entries (see `isHarEntryInFlight`).
 */
export function harEntryKey(entry: HarEntryLike): string {
  if (typeof entry._requestId === 'string' && entry._requestId.length > 0) return `id:${entry._requestId}`;
  const connection = typeof entry._connectionId === 'string' || typeof entry._connectionId === 'number' ? String(entry._connectionId) : (entry.connection ?? '');
  const error = entry.response?._error ?? '';
  const timings = entry.timings;
  const timing = error || !timings ? String(entry.time ?? '') : SETTLED_PHASES.map((phase) => timings[phase] ?? '').join(',');
  return [entry.startedDateTime ?? '', connection, entry.request?.method ?? '', entry.request?.url ?? '', entry.response?.status ?? '', error, timing].join('|');
}
