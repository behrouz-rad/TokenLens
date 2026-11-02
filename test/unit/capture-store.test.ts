import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCaptureStoreForTests, useCaptureStore } from '@/state/capture-store';
import { createSyntheticJwt, resetSyntheticSequence, withBearer } from '@/core/testing/synthetic';
import { filterTokens } from '@/hooks/use-filtered-tokens';

const NOW = 1_700_000_000_000;
const seconds = (ms: number) => Math.floor(ms / 1000);
const context = { recording: true, clearOnNavigation: false };

describe('capture store expiry scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetSyntheticSequence();
    resetCaptureStoreForTests();
  });

  afterEach(() => {
    resetCaptureStoreForTests();
    vi.useRealTimers();
  });

  const tokenOf = () => [...useCaptureStore.getState().session.tokens.values()][0]!;

  it('transitions active → expiring → expired on exact deadlines without polling', () => {
    const raw = createSyntheticJwt({ alg: 'HS256' }, { sub: 'x', exp: seconds(NOW) + 600 });
    useCaptureStore.getState().ingest([withBearer(raw)], context);
    expect(tokenOf().status).toBe('active');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(299_000);
    expect(tokenOf().status).toBe('active');
    vi.advanceTimersByTime(2_000);
    expect(tokenOf().status).toBe('expiring');

    vi.advanceTimersByTime(298_000);
    expect(tokenOf().status).toBe('expiring');
    vi.advanceTimersByTime(2_000);
    expect(tokenOf().status).toBe('expired');
    expect(useCaptureStore.getState().session.eventsByToken.get(tokenOf().id)?.some((e) => e.type === 'expired')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps filters and counts in step with transitions', () => {
    const soon = createSyntheticJwt({ alg: 'HS256' }, { sub: 'soon', exp: seconds(NOW) + 60 });
    const later = createSyntheticJwt({ alg: 'HS256' }, { sub: 'later', exp: seconds(NOW) + 3600 });
    useCaptureStore.getState().ingest([withBearer(soon), withBearer(later)], context);
    const filter = { search: '', statusFilter: null, quickFilter: 'only-expired' as const };
    const expiredNow = () => filterTokens(useCaptureStore.getState().session.tokens.values(), filter, useCaptureStore.getState().session.requests);
    expect(expiredNow()).toHaveLength(0);
    vi.advanceTimersByTime(61_000);
    expect(expiredNow().map((t) => t.decoded?.payload.sub)).toEqual(['soon']);
  });

  it('re-arms the timer when a token with an earlier deadline arrives', () => {
    useCaptureStore.getState().ingest([withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: 'late', exp: seconds(NOW) + 7200 }))], context);
    useCaptureStore.getState().ingest([withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: 'early', exp: seconds(NOW) + 30 }))], context);
    vi.advanceTimersByTime(31_000);
    const statuses = [...useCaptureStore.getState().session.tokens.values()].map((t) => [t.decoded?.payload.sub, t.status]);
    expect(statuses).toEqual([
      ['late', 'active'],
      ['early', 'expired'],
    ]);
  });

  it('clears timers and data on clear', () => {
    useCaptureStore.getState().ingest([withBearer(createSyntheticJwt({ alg: 'HS256' }, { exp: seconds(NOW) + 60 }))], context);
    expect(vi.getTimerCount()).toBe(1);
    useCaptureStore.getState().clear();
    expect(vi.getTimerCount()).toBe(0);
    expect(useCaptureStore.getState().session.tokens.size).toBe(0);
  });

  it('applies settings changes to statuses', () => {
    useCaptureStore.getState().ingest([withBearer(createSyntheticJwt({ alg: 'HS256' }, { exp: seconds(NOW) + 600 }))], context);
    expect(tokenOf().status).toBe('active');
    useCaptureStore.getState().updateSettings({ expiringThresholdMs: 15 * 60 * 1000 });
    expect(tokenOf().status).toBe('expiring');
  });
});

describe('capture store explorer filters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetSyntheticSequence();
    resetCaptureStoreForTests();
  });

  afterEach(() => {
    resetCaptureStoreForTests();
    vi.useRealTimers();
  });

  it('patches and clears the request and timeline filters independently', () => {
    const store = useCaptureStore.getState();
    store.setRequestFilter({ search: 'users', statusCategory: '4xx' });
    store.setTimelineFilter({ eventType: 'failed-request' });
    expect(useCaptureStore.getState().requestFilter).toEqual({ search: 'users', statusCategory: '4xx', tokenId: null });
    expect(useCaptureStore.getState().timelineFilter).toEqual({ tokenId: null, eventType: 'failed-request' });
    store.clearRequestFilter();
    expect(useCaptureStore.getState().requestFilter).toEqual({ search: '', statusCategory: null, tokenId: null });
    expect(useCaptureStore.getState().timelineFilter.eventType).toBe('failed-request');
    store.clearTimelineFilter();
    expect(useCaptureStore.getState().timelineFilter).toEqual({ tokenId: null, eventType: null });
  });

  it('focusing a request drops filters that could hide it, and changing a filter drops the focus', () => {
    useCaptureStore.getState().ingest([withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: 'x' }))], context);
    const requestId = [...useCaptureStore.getState().session.requests.keys()][0]!;
    useCaptureStore.getState().setRequestFilter({ statusCategory: '5xx', tokenId: 'tok-1' });
    useCaptureStore.getState().focusRequest(requestId);
    expect(useCaptureStore.getState().focusedRequestId).toBe(requestId);
    expect(useCaptureStore.getState().requestFilter).toEqual({ search: '', statusCategory: null, tokenId: null });
    useCaptureStore.getState().setRequestFilter({ search: 'x' });
    expect(useCaptureStore.getState().focusedRequestId).toBeNull();
  });

  it('forgets token-bound filters and the focused request when the session is cleared', () => {
    useCaptureStore.getState().ingest([withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: 'x' }))], context);
    const store = useCaptureStore.getState();
    store.setRequestFilter({ search: 'keep', tokenId: 'tok-1' });
    store.setTimelineFilter({ tokenId: 'tok-1', eventType: 'captured' });
    store.clear();
    expect(useCaptureStore.getState().requestFilter).toEqual({ search: 'keep', statusCategory: null, tokenId: null });
    expect(useCaptureStore.getState().timelineFilter).toEqual({ tokenId: null, eventType: 'captured' });

    useCaptureStore.getState().ingest([withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: 'y' }))], context);
    useCaptureStore.getState().focusRequest([...useCaptureStore.getState().session.requests.keys()][0]!);
    expect(useCaptureStore.getState().focusedRequestId).not.toBeNull();
    useCaptureStore.getState().clear();
    expect(useCaptureStore.getState().focusedRequestId).toBeNull();
  });
});
