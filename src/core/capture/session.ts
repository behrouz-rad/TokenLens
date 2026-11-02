import type { CaptureLimits, NetworkRequest, TimelineEvent, Token, TokenStatus } from '@/types';
import { DEFAULT_CAPTURE_LIMITS, DEFAULT_EXPIRING_THRESHOLD_MS } from '@/types';
import {
  analyzeBearerToken,
  classifyToken,
  computeTokenStatus,
  getNumericDateClaim,
  getTemporalBounds,
  inferTokenName,
  nextStatusTransition,
} from '@/core/jwt/decoder';
import { fingerprintToken } from '@/core/jwt/fingerprint';
import type { CaptureObservation, RequestObservation } from './observation';

export interface CaptureCounters {
  observedRequests: number;
  ignoredWhilePaused: number;
  evictedTokens: number;
  evictedRequests: number;
  navigations: number;
}

export interface CaptureState {
  tokens: Map<string, Token>;
  requests: Map<string, NetworkRequest>;
  eventsByToken: Map<string, TimelineEvent[]>;
  /** fingerprint → token ids sharing that fingerprint (collisions are resolved by comparing raw). */
  tokenIndex: Map<string, string[]>;
  /** Highest observation sequence processed per relay instance; survives Clear so replays stay idempotent. */
  cursorByRelay: Map<string, number>;
  tokenSequence: number;
  requestSequence: number;
  selectedTokenId: string | null;
  counters: CaptureCounters;
  lastNavigation: { url: string; at: number } | null;
  limits: CaptureLimits;
  expiringThresholdMs: number;
}

export interface IngestOptions {
  now: number;
  recording: boolean;
  clearOnNavigation: boolean;
}

const EMPTY_COUNTERS: CaptureCounters = {
  observedRequests: 0,
  ignoredWhilePaused: 0,
  evictedTokens: 0,
  evictedRequests: 0,
  navigations: 0,
};

export function createCaptureState(overrides: Partial<Pick<CaptureState, 'limits' | 'expiringThresholdMs'>> = {}): CaptureState {
  return {
    tokens: new Map(),
    requests: new Map(),
    eventsByToken: new Map(),
    tokenIndex: new Map(),
    cursorByRelay: new Map(),
    tokenSequence: 0,
    requestSequence: 0,
    selectedTokenId: null,
    counters: { ...EMPTY_COUNTERS },
    lastNavigation: null,
    limits: overrides.limits ?? { ...DEFAULT_CAPTURE_LIMITS },
    expiringThresholdMs: overrides.expiringThresholdMs ?? DEFAULT_EXPIRING_THRESHOLD_MS,
  };
}

/** Copies the collections once per batch so a burst of events costs one Map clone, not one per event. */
class Draft {
  readonly tokens: Map<string, Token>;
  readonly requests: Map<string, NetworkRequest>;
  readonly eventsByToken: Map<string, TimelineEvent[]>;
  readonly tokenIndex: Map<string, string[]>;
  readonly cursorByRelay: Map<string, number>;
  readonly counters: CaptureCounters;
  readonly clonedTokens = new Set<string>();
  readonly clonedEventLists = new Set<string>();
  tokenSequence: number;
  requestSequence: number;
  selectedTokenId: string | null;
  lastNavigation: CaptureState['lastNavigation'];
  changed = false;

  constructor(private readonly base: CaptureState) {
    this.tokens = new Map(base.tokens);
    this.requests = new Map(base.requests);
    this.eventsByToken = new Map(base.eventsByToken);
    this.tokenIndex = new Map(base.tokenIndex);
    this.cursorByRelay = new Map(base.cursorByRelay);
    this.counters = { ...base.counters };
    this.tokenSequence = base.tokenSequence;
    this.requestSequence = base.requestSequence;
    this.selectedTokenId = base.selectedTokenId;
    this.lastNavigation = base.lastNavigation;
  }

  mutableToken(id: string): Token | undefined {
    const token = this.tokens.get(id);
    if (!token) return undefined;
    if (this.clonedTokens.has(id)) return token;
    const clone: Token = { ...token, requestIds: [...token.requestIds] };
    this.tokens.set(id, clone);
    this.clonedTokens.add(id);
    this.changed = true;
    return clone;
  }

  mutableEvents(tokenId: string): TimelineEvent[] {
    const existing = this.eventsByToken.get(tokenId);
    if (existing && this.clonedEventLists.has(tokenId)) return existing;
    const clone = existing ? [...existing] : [];
    this.eventsByToken.set(tokenId, clone);
    this.clonedEventLists.add(tokenId);
    this.changed = true;
    return clone;
  }

  commit(): CaptureState {
    if (!this.changed) return this.base;
    return {
      ...this.base,
      tokens: this.tokens,
      requests: this.requests,
      eventsByToken: this.eventsByToken,
      tokenIndex: this.tokenIndex,
      cursorByRelay: this.cursorByRelay,
      counters: this.counters,
      tokenSequence: this.tokenSequence,
      requestSequence: this.requestSequence,
      selectedTokenId: this.selectedTokenId,
      lastNavigation: this.lastNavigation,
    };
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

function requestLabel(method: string, url: string): string {
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.pathname}${parsed.search}`;
  } catch {
    return `${method} ${url.slice(0, 120) || '(no URL)'}`;
  }
}

function findExistingToken(draft: Draft, fingerprint: string, raw: string): Token | undefined {
  const candidates = draft.tokenIndex.get(fingerprint);
  if (!candidates) return undefined;
  for (const id of candidates) {
    const token = draft.tokens.get(id);
    if (token?.raw === raw) return token;
  }
  return undefined;
}

function createToken(draft: Draft, raw: string, observation: RequestObservation, now: number, expiringThresholdMs: number): Token {
  const analysis = analyzeBearerToken(raw);
  const classification = classifyToken(analysis);
  const bounds = getTemporalBounds(analysis.decoded);
  const sequenceNumber = ++draft.tokenSequence;
  const token: Token = {
    id: `tok-${sequenceNumber}`,
    sequenceNumber,
    fingerprint: fingerprintToken(raw),
    name: inferTokenName(classification.type),
    type: classification.type,
    format: analysis.format,
    typeBasis: classification.basis,
    source: 'authorization-header',
    domain: safeHostname(observation.url),
    capturedAt: observation.startedAt,
    lastSeenAt: observation.startedAt,
    status: computeTokenStatus(analysis.format, analysis.decoded, now, expiringThresholdMs),
    expiresAt: bounds.expiresAt,
    notBeforeAt: bounds.notBeforeAt,
    decoded: analysis.decoded,
    formatDetail: analysis.detail,
    raw,
    requestIds: [],
  };

  draft.tokens.set(token.id, token);
  draft.clonedTokens.add(token.id);
  const bucket = draft.tokenIndex.get(token.fingerprint);
  draft.tokenIndex.set(token.fingerprint, bucket ? [...bucket, token.id] : [token.id]);
  draft.changed = true;

  const events = draft.mutableEvents(token.id);
  if (analysis.decoded) {
    const iat = getNumericDateClaim(analysis.decoded.payload, 'iat');
    if (iat.kind === 'valid' && iat.ms <= now) {
      events.push({ id: `${token.id}-issued`, tokenId: token.id, type: 'issued', timestamp: iat.ms, label: 'Issued (iat)' });
    }
  }
  events.push({ id: `${token.id}-captured`, tokenId: token.id, type: 'captured', timestamp: observation.startedAt, label: 'First observed' });
  if (token.status === 'expired' && token.expiresAt !== null) {
    events.push({ id: `${token.id}-expired`, tokenId: token.id, type: 'expired', timestamp: token.expiresAt, label: 'Expired (exp)' });
  }
  draft.selectedTokenId ??= token.id;
  return token;
}

function ingestRequest(draft: Draft, observation: RequestObservation, options: IngestOptions, expiringThresholdMs: number): void {
  draft.counters.observedRequests += 1;
  draft.changed = true;
  const raw = observation.bearerToken;
  if (!raw) return;

  const fingerprint = fingerprintToken(raw);
  const existing = findExistingToken(draft, fingerprint, raw);
  const token = existing ? draft.mutableToken(existing.id) : createToken(draft, raw, observation, options.now, expiringThresholdMs);
  if (!token) return;

  const requestId = `req-${++draft.requestSequence}`;
  const request: NetworkRequest = {
    id: requestId,
    url: observation.url,
    method: observation.method,
    status: observation.status,
    statusText: observation.statusText,
    durationMs: observation.durationMs,
    startedAt: observation.startedAt,
    tokenId: token.id,
  };
  draft.requests.set(requestId, request);
  token.requestIds.push(requestId);
  if (observation.startedAt > token.lastSeenAt) token.lastSeenAt = observation.startedAt;

  const failed = observation.status >= 400;
  draft.mutableEvents(token.id).push({
    id: `${requestId}-used`,
    tokenId: token.id,
    type: failed ? 'failed-request' : 'used-in-request',
    timestamp: observation.startedAt,
    label: requestLabel(observation.method, observation.url),
    requestId,
    status: observation.status,
  });
}

function removeRequest(draft: Draft, requestId: string): void {
  const request = draft.requests.get(requestId);
  if (!request) return;
  draft.requests.delete(requestId);
  draft.changed = true;
  const token = draft.mutableToken(request.tokenId);
  if (token) {
    const index = token.requestIds.indexOf(requestId);
    if (index >= 0) token.requestIds.splice(index, 1);
    const events = draft.mutableEvents(token.id);
    const eventIndex = events.findIndex((e) => e.requestId === requestId);
    if (eventIndex >= 0) events.splice(eventIndex, 1);
  }
}

function removeToken(draft: Draft, tokenId: string): void {
  const token = draft.tokens.get(tokenId);
  if (!token) return;
  for (const requestId of token.requestIds) draft.requests.delete(requestId);
  draft.tokens.delete(tokenId);
  draft.eventsByToken.delete(tokenId);
  const bucket = draft.tokenIndex.get(token.fingerprint);
  if (bucket) {
    const remaining = bucket.filter((id) => id !== tokenId);
    if (remaining.length) draft.tokenIndex.set(token.fingerprint, remaining);
    else draft.tokenIndex.delete(token.fingerprint);
  }
  if (draft.selectedTokenId === tokenId) draft.selectedTokenId = null;
  draft.changed = true;
}

/**
 * Tokens are evicted least-recently-seen first so credentials still in use survive; requests are
 * evicted oldest first. The selected token is skipped so an inspection in progress is not pulled away.
 */
function enforceLimits(draft: Draft, limits: CaptureLimits): void {
  if (draft.tokens.size > limits.maxTokens) {
    const candidates = [...draft.tokens.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt || a.sequenceNumber - b.sequenceNumber);
    for (const token of candidates) {
      if (draft.tokens.size <= limits.maxTokens) break;
      if (token.id === draft.selectedTokenId) continue;
      removeToken(draft, token.id);
      draft.counters.evictedTokens += 1;
    }
  }
  if (draft.requests.size > limits.maxRequests) {
    for (const id of [...draft.requests.keys()]) {
      if (draft.requests.size <= limits.maxRequests) break;
      removeRequest(draft, id);
      draft.counters.evictedRequests += 1;
    }
  }
}

function resetCollections(draft: Draft): void {
  draft.tokens.clear();
  draft.requests.clear();
  draft.eventsByToken.clear();
  draft.tokenIndex.clear();
  draft.tokenSequence = 0;
  draft.requestSequence = 0;
  draft.selectedTokenId = null;
  draft.changed = true;
}

export function ingestObservations(state: CaptureState, observations: readonly CaptureObservation[], options: IngestOptions): CaptureState {
  if (observations.length === 0) return state;
  const draft = new Draft(state);

  for (const observation of observations) {
    const cursor = draft.cursorByRelay.get(observation.relayId) ?? -1;
    if (observation.seq <= cursor) continue;
    draft.cursorByRelay.set(observation.relayId, observation.seq);
    draft.changed = true;

    if (observation.kind === 'navigation') {
      draft.counters.navigations += 1;
      draft.lastNavigation = { url: observation.url, at: observation.at };
      if (options.clearOnNavigation) resetCollections(draft);
      continue;
    }
    if (!options.recording) {
      draft.counters.ignoredWhilePaused += 1;
      continue;
    }
    ingestRequest(draft, observation, options, state.expiringThresholdMs);
  }

  enforceLimits(draft, state.limits);
  return draft.commit();
}

/** Recomputes temporal statuses; returns the same state object when nothing changed. */
export function refreshStatuses(state: CaptureState, now: number): CaptureState {
  let draft: Draft | null = null;
  for (const token of state.tokens.values()) {
    if (token.format !== 'jwt') continue;
    const status: TokenStatus = computeTokenStatus(token.format, token.decoded, now, state.expiringThresholdMs);
    if (status === token.status) continue;
    draft ??= new Draft(state);
    const mutable = draft.mutableToken(token.id);
    if (!mutable) continue;
    mutable.status = status;
    if (status === 'expired' && mutable.expiresAt !== null) {
      const events = draft.mutableEvents(token.id);
      if (!events.some((e) => e.type === 'expired')) {
        events.push({ id: `${token.id}-expired`, tokenId: token.id, type: 'expired', timestamp: mutable.expiresAt, label: 'Expired (exp)' });
      }
    }
  }
  return draft ? draft.commit() : state;
}

export function nextStatusTransitionAt(state: CaptureState, now: number): number | null {
  let next: number | null = null;
  for (const token of state.tokens.values()) {
    const candidate = nextStatusTransition(token.format, token.decoded, now, state.expiringThresholdMs);
    if (candidate !== null && (next === null || candidate < next)) next = candidate;
  }
  return next;
}

export function clearCapture(state: CaptureState): CaptureState {
  return {
    ...createCaptureState({ limits: state.limits, expiringThresholdMs: state.expiringThresholdMs }),
    cursorByRelay: state.cursorByRelay,
    counters: { ...EMPTY_COUNTERS },
  };
}

export function selectToken(state: CaptureState, tokenId: string | null): CaptureState {
  if (tokenId !== null && !state.tokens.has(tokenId)) return state;
  if (state.selectedTokenId === tokenId) return state;
  return { ...state, selectedTokenId: tokenId };
}

export function applySettings(state: CaptureState, settings: Partial<Pick<CaptureState, 'limits' | 'expiringThresholdMs'>>, now: number): CaptureState {
  const next: CaptureState = {
    ...state,
    limits: settings.limits ?? state.limits,
    expiringThresholdMs: settings.expiringThresholdMs ?? state.expiringThresholdMs,
  };
  const draft = new Draft(next);
  enforceLimits(draft, next.limits);
  return refreshStatuses(draft.commit(), now);
}

export function eventsForToken(state: CaptureState, tokenId: string): TimelineEvent[] {
  return state.eventsByToken.get(tokenId) ?? [];
}

export function requestsForToken(state: CaptureState, token: Token): NetworkRequest[] {
  const result: NetworkRequest[] = [];
  for (const id of token.requestIds) {
    const request = state.requests.get(id);
    if (request) result.push(request);
  }
  return result;
}

/** Invariants that every state transition must preserve; exercised by tests and the dev-mode assertion hook. */
export function verifyReferentialIntegrity(state: CaptureState): string[] {
  const problems: string[] = [];
  for (const [id, token] of state.tokens) {
    if (token.id !== id) problems.push(`token key ${id} does not match token.id ${token.id}`);
    for (const requestId of token.requestIds) {
      const request = state.requests.get(requestId);
      if (!request) problems.push(`token ${id} references missing request ${requestId}`);
      else if (request.tokenId !== id) problems.push(`request ${requestId} belongs to ${request.tokenId}, not ${id}`);
    }
    const bucket = state.tokenIndex.get(token.fingerprint);
    if (!bucket?.includes(id)) problems.push(`token ${id} missing from fingerprint index`);
  }
  for (const [id, request] of state.requests) {
    const token = state.tokens.get(request.tokenId);
    if (!token) problems.push(`request ${id} references missing token ${request.tokenId}`);
    else if (!token.requestIds.includes(id)) problems.push(`request ${id} not listed on token ${token.id}`);
  }
  for (const [tokenId, events] of state.eventsByToken) {
    if (!state.tokens.has(tokenId)) problems.push(`events exist for missing token ${tokenId}`);
    for (const event of events) {
      if (event.tokenId !== tokenId) problems.push(`event ${event.id} filed under wrong token`);
      if (event.requestId && !state.requests.has(event.requestId)) problems.push(`event ${event.id} references missing request`);
    }
  }
  for (const [fingerprint, ids] of state.tokenIndex) {
    for (const id of ids) {
      const token = state.tokens.get(id);
      if (!token) problems.push(`index entry ${fingerprint} references missing token ${id}`);
      else if (token.fingerprint !== fingerprint) problems.push(`token ${id} indexed under wrong fingerprint`);
    }
  }
  if (state.selectedTokenId !== null && !state.tokens.has(state.selectedTokenId)) {
    problems.push(`selected token ${state.selectedTokenId} does not exist`);
  }
  return problems;
}
