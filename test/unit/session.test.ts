import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySettings,
  clearCapture,
  createCaptureState,
  ingestObservations,
  nextStatusTransitionAt,
  refreshStatuses,
  requestsForToken,
  selectToken,
  verifyReferentialIntegrity,
  type CaptureState,
} from '@/core/capture/session';
import { createNavigationObservation, createRequestObservation, createSyntheticJwt, resetSyntheticSequence, withBearer } from '@/core/testing/synthetic';
import { fingerprintToken } from '@/core/jwt/fingerprint';
import type { CaptureObservation } from '@/core/capture/observation';

const NOW = 1_700_000_000_000;
const seconds = (ms: number) => Math.floor(ms / 1000);
const opts = { now: NOW, recording: true, clearOnNavigation: false };

const TOKEN_A = createSyntheticJwt({ alg: 'RS256', typ: 'at+jwt' }, { sub: 'a', exp: seconds(NOW) + 3600, iat: seconds(NOW) - 60 });
const TOKEN_B = createSyntheticJwt({ alg: 'RS256' }, { sub: 'b', exp: seconds(NOW) + 3600 });
const OPAQUE = 'opaque-token-value';

function ingest(state: CaptureState, observations: CaptureObservation[], overrides: Partial<typeof opts> = {}): CaptureState {
  const next = ingestObservations(state, observations, { ...opts, ...overrides });
  expect(verifyReferentialIntegrity(next)).toEqual([]);
  return next;
}

beforeEach(() => resetSyntheticSequence());

describe('canonical token identity', () => {
  it('creates one token and one request on first occurrence', () => {
    const state = ingest(createCaptureState(), [withBearer(TOKEN_A, { url: 'https://api.example.test/a' })]);
    expect(state.tokens.size).toBe(1);
    expect(state.requests.size).toBe(1);
    const token = [...state.tokens.values()][0]!;
    const request = [...state.requests.values()][0]!;
    expect(request.tokenId).toBe(token.id);
    expect(token.requestIds).toEqual([request.id]);
    expect(token.type).toBe('JWT (Access)');
    expect(token.domain).toBe('api.example.test');
    expect(state.selectedTokenId).toBe(token.id);
  });

  it('reuses the canonical id for repeated occurrences, across endpoints and delivery batches', () => {
    let state = ingest(createCaptureState(), [withBearer(TOKEN_A, { url: 'https://api.example.test/a' })]);
    state = ingest(state, [withBearer(TOKEN_A, { url: 'https://api.example.test/b', method: 'POST' })]);
    state = ingest(state, [withBearer(TOKEN_A, { url: 'https://other.example.test/c' }), withBearer(TOKEN_A, { url: 'https://other.example.test/c' })]);
    expect(state.tokens.size).toBe(1);
    expect(state.requests.size).toBe(4);
    const token = [...state.tokens.values()][0]!;
    expect(token.requestIds).toHaveLength(4);
    for (const request of state.requests.values()) expect(request.tokenId).toBe(token.id);
    expect(state.eventsByToken.get(token.id)?.filter((e) => e.type === 'used-in-request')).toHaveLength(4);
    expect(state.eventsByToken.get(token.id)?.filter((e) => e.type === 'captured')).toHaveLength(1);
  });

  it('keeps distinct tokens separate, including same-URL concurrent requests', () => {
    const state = ingest(createCaptureState(), [
      withBearer(TOKEN_A, { url: 'https://api.example.test/x', startedAt: NOW }),
      withBearer(TOKEN_B, { url: 'https://api.example.test/x', startedAt: NOW }),
      withBearer(OPAQUE, { url: 'https://api.example.test/x', startedAt: NOW }),
      withBearer(TOKEN_A, { url: 'https://api.example.test/x', startedAt: NOW }),
    ]);
    expect(state.tokens.size).toBe(3);
    expect(state.requests.size).toBe(4);
    const a = [...state.tokens.values()].find((t) => t.raw === TOKEN_A)!;
    expect(a.requestIds).toHaveLength(2);
    expect([...state.tokens.values()].find((t) => t.raw === OPAQUE)?.format).toBe('opaque');
  });

  it('does not collapse distinct requests that share method, URL and token', () => {
    const observation = () => withBearer(TOKEN_A, { url: 'https://api.example.test/same', method: 'GET', startedAt: NOW, durationMs: 10 });
    const state = ingest(createCaptureState(), [observation(), observation(), observation()]);
    expect(state.requests.size).toBe(3);
  });

  it('correlates failed requests to the existing token and records failed-request events', () => {
    let state = ingest(createCaptureState(), [withBearer(TOKEN_A, { status: 200 })]);
    state = ingest(state, [withBearer(TOKEN_A, { status: 401, statusText: 'Unauthorized' }), withBearer(TOKEN_A, { status: 500 })]);
    const token = [...state.tokens.values()][0]!;
    const requests = requestsForToken(state, token);
    expect(requests.map((r) => r.status).sort()).toEqual([200, 401, 500]);
    const events = state.eventsByToken.get(token.id)!;
    expect(events.filter((e) => e.type === 'failed-request')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'used-in-request')).toHaveLength(1);
  });

  it('indexes tokens by fingerprint and tolerates collisions by comparing raw values', () => {
    const state = ingest(createCaptureState(), [withBearer(TOKEN_A), withBearer(TOKEN_B)]);
    expect(state.tokenIndex.get(fingerprintToken(TOKEN_A))).toHaveLength(1);
    expect(state.tokenIndex.get(fingerprintToken(TOKEN_B))).toHaveLength(1);
    const collided: CaptureState = { ...state, tokenIndex: new Map([[fingerprintToken(TOKEN_A), [...state.tokens.keys()]]]) };
    const next = ingestObservations(collided, [withBearer(TOKEN_A)], opts);
    expect(next.tokens.size).toBe(2);
    expect([...next.tokens.values()].find((t) => t.raw === TOKEN_A)?.requestIds).toHaveLength(2);
  });

  it('ignores requests without a Bearer token but counts them', () => {
    const state = ingest(createCaptureState(), [createRequestObservation(), createRequestObservation({ authorizationScheme: 'other' })]);
    expect(state.tokens.size).toBe(0);
    expect(state.requests.size).toBe(0);
    expect(state.counters.observedRequests).toBe(2);
  });

  it('keeps unrelated valid data when a URL is malformed', () => {
    const state = ingest(createCaptureState(), [withBearer(TOKEN_A, { url: 'not a url' }), withBearer(TOKEN_B, { url: 'https://ok.example.test/' })]);
    expect(state.tokens.size).toBe(2);
    expect([...state.tokens.values()].find((t) => t.raw === TOKEN_A)?.domain).toBe('unknown');
    expect(state.eventsByToken.get([...state.tokens.values()].find((t) => t.raw === TOKEN_A)!.id)?.some((e) => e.label.includes('not a url'))).toBe(true);
  });
});

describe('observation deduplication', () => {
  it('ignores observations already processed from the same relay (HAR replay / duplicate delivery)', () => {
    const observations = [withBearer(TOKEN_A), withBearer(TOKEN_B)];
    let state = ingest(createCaptureState(), observations);
    state = ingest(state, observations);
    state = ingest(state, [observations[1]!]);
    expect(state.requests.size).toBe(2);
    expect(state.tokens.size).toBe(2);
  });

  it('treats a new relay instance (DevTools reopened) as a fresh sequence', () => {
    let state = ingest(createCaptureState(), [withBearer(TOKEN_A)]);
    state = ingest(state, [withBearer(TOKEN_A, { relayId: 'relay-2', seq: 1 })]);
    expect(state.requests.size).toBe(2);
    expect(state.tokens.size).toBe(1);
  });
});

describe('recording and navigation', () => {
  it('drops observations while paused and never backfills them on resume', () => {
    let state = ingest(createCaptureState(), [withBearer(TOKEN_A)]);
    const paused = [withBearer(TOKEN_A), withBearer(TOKEN_B)];
    state = ingest(state, paused, { recording: false });
    expect(state.requests.size).toBe(1);
    expect(state.counters.ignoredWhilePaused).toBe(2);
    state = ingest(state, paused, { recording: true });
    expect(state.requests.size).toBe(1);
    state = ingest(state, [withBearer(TOKEN_B)], { recording: true });
    expect(state.requests.size).toBe(2);
  });

  it('preserves data across navigation by default and clears it when configured', () => {
    let state = ingest(createCaptureState(), [withBearer(TOKEN_A)]);
    state = ingest(state, [createNavigationObservation('https://app.example.test/next', NOW + 1)]);
    expect(state.tokens.size).toBe(1);
    expect(state.counters.navigations).toBe(1);
    expect(state.lastNavigation).toEqual({ url: 'https://app.example.test/next', at: NOW + 1 });

    state = ingest(state, [createNavigationObservation('https://app.example.test/again', NOW + 2), withBearer(TOKEN_B)], { clearOnNavigation: true });
    expect(state.tokens.size).toBe(1);
    expect([...state.tokens.values()][0]?.raw).toBe(TOKEN_B);
    expect([...state.tokens.values()][0]?.sequenceNumber).toBe(1);
  });
});

describe('clearing', () => {
  it('removes all records, keeps the relay cursor, and assigns fresh identities afterwards', () => {
    const first = withBearer(TOKEN_A);
    let state = ingest(createCaptureState(), [first]);
    const originalId = [...state.tokens.keys()][0]!;
    state = clearCapture(state);
    expect(state.tokens.size).toBe(0);
    expect(state.requests.size).toBe(0);
    expect(state.eventsByToken.size).toBe(0);
    expect(state.tokenIndex.size).toBe(0);
    expect(state.selectedTokenId).toBeNull();
    expect(state.counters.observedRequests).toBe(0);

    state = ingest(state, [first]);
    expect(state.tokens.size).toBe(0);

    state = ingest(state, [withBearer(TOKEN_A)]);
    expect(state.tokens.size).toBe(1);
    const token = [...state.tokens.values()][0]!;
    expect(token.id).toBe(originalId);
    expect(token.sequenceNumber).toBe(1);
    expect(token.requestIds).toHaveLength(1);
  });
});

describe('eviction', () => {
  it('evicts the oldest requests and detaches them from their tokens and events', () => {
    let state = createCaptureState({ limits: { maxTokens: 10, maxRequests: 3 } });
    state = ingest(state, [withBearer(TOKEN_A), withBearer(TOKEN_A), withBearer(TOKEN_B), withBearer(TOKEN_B), withBearer(TOKEN_A)]);
    expect(state.requests.size).toBe(3);
    expect(state.counters.evictedRequests).toBe(2);
    const a = [...state.tokens.values()].find((t) => t.raw === TOKEN_A)!;
    const b = [...state.tokens.values()].find((t) => t.raw === TOKEN_B)!;
    expect(a.requestIds).toHaveLength(1);
    expect(b.requestIds).toHaveLength(2);
    expect(state.eventsByToken.get(a.id)?.filter((e) => e.requestId)).toHaveLength(1);
  });

  it('evicts the oldest tokens together with their requests and clears their selection', () => {
    let state = createCaptureState({ limits: { maxTokens: 2, maxRequests: 100 } });
    const tokens = [1, 2, 3, 4].map((i) => createSyntheticJwt({ alg: 'HS256' }, { sub: `s${i}`, exp: seconds(NOW) + 100 }));
    state = ingest(state, [withBearer(tokens[0]!), withBearer(tokens[1]!)]);
    state = selectToken(state, [...state.tokens.keys()][1]!);
    state = ingest(state, [withBearer(tokens[2]!), withBearer(tokens[3]!)]);
    expect(state.tokens.size).toBe(2);
    expect(state.counters.evictedTokens).toBe(2);
    expect([...state.tokens.values()].map((t) => t.raw)).toEqual([tokens[1], tokens[3]]);
    expect(state.requests.size).toBe(2);
    expect(state.selectedTokenId).toBe([...state.tokens.keys()][0]);
  });

  it('applies tightened limits immediately', () => {
    let state = ingest(createCaptureState(), Array.from({ length: 20 }, (_, i) => withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: `s${i}` }))));
    state = applySettings(state, { limits: { maxTokens: 5, maxRequests: 5 } }, NOW);
    expect(state.tokens.size).toBe(5);
    expect(state.requests.size).toBe(5);
    expect(verifyReferentialIntegrity(state)).toEqual([]);
  });
});

describe('status refresh', () => {
  it('moves tokens through expiring and expired and records an expired event once', () => {
    const raw = createSyntheticJwt({ alg: 'HS256' }, { sub: 'x', exp: seconds(NOW) + 600 });
    let state = ingest(createCaptureState(), [withBearer(raw)]);
    const id = [...state.tokens.keys()][0]!;
    expect(state.tokens.get(id)?.status).toBe('active');
    expect(nextStatusTransitionAt(state, NOW)).toBe((seconds(NOW) + 600) * 1000 - 5 * 60 * 1000);

    expect(refreshStatuses(state, NOW + 1000)).toBe(state);
    state = refreshStatuses(state, NOW + 301_000);
    expect(state.tokens.get(id)?.status).toBe('expiring');
    state = refreshStatuses(state, NOW + 601_000);
    expect(state.tokens.get(id)?.status).toBe('expired');
    state = refreshStatuses(state, NOW + 602_000);
    expect(state.eventsByToken.get(id)?.filter((e) => e.type === 'expired')).toHaveLength(1);
    expect(nextStatusTransitionAt(state, NOW + 602_000)).toBeNull();
  });

  it('respects a changed expiring threshold', () => {
    const raw = createSyntheticJwt({ alg: 'HS256' }, { sub: 'x', exp: seconds(NOW) + 600 });
    let state = ingest(createCaptureState(), [withBearer(raw)]);
    state = applySettings(state, { expiringThresholdMs: 15 * 60 * 1000 }, NOW);
    expect([...state.tokens.values()][0]?.status).toBe('expiring');
  });
});

describe('selection', () => {
  it('ignores selection of unknown ids and keeps references stable when nothing changes', () => {
    const state = ingest(createCaptureState(), [withBearer(TOKEN_A)]);
    expect(selectToken(state, 'missing')).toBe(state);
    expect(selectToken(state, state.selectedTokenId)).toBe(state);
    expect(selectToken(state, null).selectedTokenId).toBeNull();
  });
});

describe('scale', () => {
  it('handles thousands of requests across hundreds of tokens with intact integrity', () => {
    const tokens = Array.from({ length: 300 }, (_, i) => createSyntheticJwt({ alg: 'HS256' }, { sub: `user-${i}`, exp: seconds(NOW) + 3600 + i }));
    const observations = Array.from({ length: 6000 }, (_, i) => withBearer(tokens[i % tokens.length]!, { url: `https://api.example.test/r/${i}`, status: i % 7 === 0 ? 401 : 200 }));
    const started = performance.now();
    let state = createCaptureState();
    for (let i = 0; i < observations.length; i += 500) state = ingestObservations(state, observations.slice(i, i + 500), opts);
    const elapsed = performance.now() - started;
    expect(state.tokens.size).toBe(300);
    expect(state.requests.size).toBe(5000);
    expect(state.counters.evictedRequests).toBe(1000);
    expect(verifyReferentialIntegrity(state)).toEqual([]);
    expect(elapsed).toBeLessThan(5000);
  });
});
