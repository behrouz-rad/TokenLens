import { beforeEach, describe, expect, it } from 'vitest';
import { EVENT_BASIS, EVENT_TYPE_ORDER, collectTimeline, isTimelineFilterActive } from '@/hooks/use-global-timeline';
import { applySettings, clearCapture, createCaptureState, ingestObservations, refreshStatuses, type CaptureState } from '@/core/capture/session';
import { createSyntheticJwt, resetSyntheticSequence, withBearer } from '@/core/testing/synthetic';
import type { TimelineEventType, TimelineFilter } from '@/types';

const NOW = 1_700_000_000_000;
const seconds = (ms: number) => Math.floor(ms / 1000);
const none: TimelineFilter = { tokenId: null, eventType: null };
const opts = { now: NOW, recording: true, clearOnNavigation: false };

const ACCESS = createSyntheticJwt({ alg: 'RS256', typ: 'at+jwt' }, { sub: 'alice', exp: seconds(NOW) + 3600, iat: seconds(NOW) - 600 });
const EXPIRED = createSyntheticJwt({ alg: 'HS256' }, { sub: 'old', exp: seconds(NOW) - 60, iat: seconds(NOW) - 7200 });
const SOON = createSyntheticJwt({ alg: 'HS256' }, { sub: 'soon', exp: seconds(NOW) + 30 });

function buildState(): CaptureState {
  return ingestObservations(
    createCaptureState(),
    [
      withBearer(ACCESS, { url: 'https://api.example.test/users', startedAt: NOW - 50_000 }),
      withBearer(ACCESS, { url: 'https://api.example.test/admin', status: 403, startedAt: NOW - 30_000 }),
      withBearer(EXPIRED, { url: 'https://old.example.test/profile', status: 401, startedAt: NOW - 20_000 }),
      withBearer(SOON, { url: 'https://api.example.test/soon', startedAt: NOW - 10_000 }),
    ],
    opts
  );
}

const tokenByRaw = (state: CaptureState, raw: string) => [...state.tokens.values()].find((t) => t.raw === raw)!;

beforeEach(() => resetSyntheticSequence());

describe('event basis', () => {
  it('marks traffic-derived events as observed and claim-derived events as claims', () => {
    expect(EVENT_BASIS.captured).toBe('observed');
    expect(EVENT_BASIS['used-in-request']).toBe('observed');
    expect(EVENT_BASIS['failed-request']).toBe('observed');
    expect(EVENT_BASIS.issued).toBe('claim');
    expect(EVENT_BASIS.expired).toBe('claim');
    const allTypes: TimelineEventType[] = ['captured', 'used-in-request', 'failed-request', 'expired', 'issued'];
    expect([...EVENT_TYPE_ORDER].sort()).toEqual([...allTypes].sort());
  });
});

describe('collectTimeline', () => {
  it('flattens every token event into one stream, newest first, with its token attached', () => {
    const state = buildState();
    const rows = collectTimeline(state.eventsByToken, state.tokens, none);
    const expected = [...state.eventsByToken.values()].reduce((n, events) => n + events.length, 0);
    expect(rows).toHaveLength(expected);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.event.timestamp).toBeGreaterThanOrEqual(rows[i]!.event.timestamp);
    for (const row of rows) {
      expect(row.token?.id).toBe(row.event.tokenId);
      expect(row.basis).toBe(EVENT_BASIS[row.event.type]);
    }
  });

  it('never invents issuance: a token without iat has no issued event, and first observation is "captured"', () => {
    const state = buildState();
    const soon = tokenByRaw(state, SOON);
    const rows = collectTimeline(state.eventsByToken, state.tokens, { ...none, tokenId: soon.id });
    expect(rows.map((r) => r.event.type)).toEqual(['used-in-request', 'captured']);
    expect(rows.find((r) => r.event.type === 'captured')?.event.label).toBe('First observed');
  });

  it('places claim-derived events at the claimed time, not the observation time', () => {
    const state = buildState();
    const expired = tokenByRaw(state, EXPIRED);
    const rows = collectTimeline(state.eventsByToken, state.tokens, { ...none, tokenId: expired.id });
    const issued = rows.find((r) => r.event.type === 'issued')!;
    const expiredEvent = rows.find((r) => r.event.type === 'expired')!;
    expect(issued.event.timestamp).toBe((seconds(NOW) - 7200) * 1000);
    expect(expiredEvent.event.timestamp).toBe((seconds(NOW) - 60) * 1000);
    expect(issued.basis).toBe('claim');
    expect(expiredEvent.basis).toBe('claim');
  });

  it('records an expiry transition once when time passes', () => {
    let state = buildState();
    state = refreshStatuses(state, NOW + 31_000);
    state = refreshStatuses(state, NOW + 62_000);
    const soon = tokenByRaw(state, SOON);
    const rows = collectTimeline(state.eventsByToken, state.tokens, { tokenId: soon.id, eventType: 'expired' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.timestamp).toBe((seconds(NOW) + 30) * 1000);
  });

  it('filters by event type and by token', () => {
    const state = buildState();
    const access = tokenByRaw(state, ACCESS);
    expect(collectTimeline(state.eventsByToken, state.tokens, { ...none, eventType: 'failed-request' }).map((r) => r.event.status)).toEqual([401, 403]);
    expect(collectTimeline(state.eventsByToken, state.tokens, { ...none, eventType: 'captured' })).toHaveLength(3);
    expect(collectTimeline(state.eventsByToken, state.tokens, { tokenId: access.id, eventType: 'used-in-request' })).toHaveLength(1);
    expect(collectTimeline(state.eventsByToken, state.tokens, { ...none, tokenId: 'tok-404' })).toEqual([]);
    expect(isTimelineFilterActive(none)).toBe(false);
    expect(isTimelineFilterActive({ ...none, eventType: 'issued' })).toBe(true);
  });

  it('drops events with their requests and tokens on eviction and clearing', () => {
    let state = buildState();
    state = applySettings(state, { limits: { maxTokens: 2, maxRequests: 2 } }, NOW);
    const rows = collectTimeline(state.eventsByToken, state.tokens, none);
    for (const row of rows) {
      expect(row.token).not.toBeNull();
      if (row.event.requestId) expect(state.requests.has(row.event.requestId)).toBe(true);
    }
    expect(collectTimeline(clearCapture(state).eventsByToken, state.tokens, none)).toEqual([]);
  });

  it('handles thousands of events quickly', () => {
    const tokens = Array.from({ length: 100 }, (_, i) => createSyntheticJwt({ alg: 'HS256' }, { sub: `bulk-${i}`, exp: seconds(NOW) + 3600, iat: seconds(NOW) - i }));
    const observations = Array.from({ length: 4000 }, (_, i) => withBearer(tokens[i % tokens.length]!, { url: `https://api.example.test/bulk/${i}`, startedAt: NOW + i }));
    const state = ingestObservations(createCaptureState(), observations, opts);
    const started = performance.now();
    const rows = collectTimeline(state.eventsByToken, state.tokens, none);
    expect(performance.now() - started).toBeLessThan(500);
    expect(rows).toHaveLength(4000 + 100 + 100);
  });
});
