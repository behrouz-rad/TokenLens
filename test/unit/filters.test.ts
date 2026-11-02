import { beforeEach, describe, expect, it } from 'vitest';
import { filterTokens, filterRequestsExpired, isFilterActive, matchesQuickFilter, matchesSearch } from '@/hooks/use-filtered-tokens';
import { createCaptureState, ingestObservations } from '@/core/capture/session';
import { createSyntheticJwt, resetSyntheticSequence, withBearer } from '@/core/testing/synthetic';
import type { TokenFilter } from '@/types';

const NOW = 1_700_000_000_000;
const seconds = (ms: number) => Math.floor(ms / 1000);
const none: TokenFilter = { search: '', statusFilter: null, quickFilter: null };

function buildState() {
  const expired = createSyntheticJwt({ alg: 'HS256' }, { sub: 'expired-user', iss: 'https://old.example.test', exp: seconds(NOW) - 10 });
  const expiring = createSyntheticJwt({ alg: 'HS256' }, { sub: 'expiring-user', exp: seconds(NOW) + 60 });
  const active = createSyntheticJwt({ alg: 'HS256' }, { sub: 'active-user', exp: seconds(NOW) + 3600 });
  const malformed = 'eyJhbGciOiJSUzI1NiJ9.%%%.sig';
  const opaque = 'opaque-token';
  return ingestObservations(
    createCaptureState(),
    [
      withBearer(expired, { url: 'https://old.example.test/a', status: 401 }),
      withBearer(expiring, { url: 'https://api.example.test/b' }),
      withBearer(active, { url: 'https://api.example.test/c' }),
      withBearer(active, { url: 'https://api.example.test/d', status: 500 }),
      withBearer(malformed, { url: 'https://api.example.test/e', status: 401 }),
      withBearer(opaque, { url: 'https://oauth.example.test/f' }),
    ],
    { now: NOW, recording: true, clearOnNavigation: false }
  );
}

beforeEach(() => resetSyntheticSequence());

describe('filterTokens', () => {
  it('returns everything, newest first, with no filter', () => {
    const state = buildState();
    const result = filterTokens(state.tokens.values(), none, state.requests);
    expect(result).toHaveLength(5);
    expect(result.map((t) => t.sequenceNumber)).toEqual([5, 4, 3, 2, 1]);
  });

  it('filters by status including expired-only', () => {
    const state = buildState();
    expect(filterTokens(state.tokens.values(), { ...none, statusFilter: 'expired' }, state.requests).map((t) => t.decoded?.payload.sub)).toEqual(['expired-user']);
    expect(filterTokens(state.tokens.values(), { ...none, statusFilter: 'no-expiry' }, state.requests).map((t) => t.format)).toEqual(['opaque']);
    expect(filterTokens(state.tokens.values(), { ...none, statusFilter: 'malformed' }, state.requests).map((t) => t.format)).toEqual(['malformed-jwt']);
  });

  it('applies quick filters with correct failed-request detection', () => {
    const state = buildState();
    const failed = filterTokens(state.tokens.values(), { ...none, quickFilter: 'failed-requests' }, state.requests);
    expect(failed.map((t) => t.name).sort()).toEqual(['jwt_token', 'jwt_token', 'malformed_token']);
    expect(filterTokens(state.tokens.values(), { ...none, quickFilter: 'only-expired' }, state.requests)).toHaveLength(1);
    expect(filterTokens(state.tokens.values(), { ...none, quickFilter: 'expiring-soon' }, state.requests)).toHaveLength(1);
    expect(filterTokens(state.tokens.values(), { ...none, quickFilter: 'invalid-tokens' }, state.requests).map((t) => t.format)).toEqual(['malformed-jwt']);
  });

  it('combines search with other filters predictably', () => {
    const state = buildState();
    expect(filterTokens(state.tokens.values(), { ...none, search: 'example.test' }, state.requests)).toHaveLength(5);
    expect(filterTokens(state.tokens.values(), { ...none, search: 'OLD.example' }, state.requests)).toHaveLength(1);
    expect(filterTokens(state.tokens.values(), { ...none, search: 'active-user', quickFilter: 'failed-requests' }, state.requests)).toHaveLength(1);
    expect(filterTokens(state.tokens.values(), { ...none, search: 'active-user', statusFilter: 'expired' }, state.requests)).toHaveLength(0);
    expect(filterTokens(state.tokens.values(), { ...none, search: '#2' }, state.requests).map((t) => t.sequenceNumber)).toEqual([2]);
    expect(filterTokens(state.tokens.values(), { ...none, search: 'opaque' }, state.requests)).toHaveLength(1);
  });

  it('reports when expired tokens must be visible regardless of the hide-expired toggle', () => {
    expect(filterRequestsExpired({ ...none, statusFilter: 'expired' })).toBe(true);
    expect(filterRequestsExpired({ ...none, quickFilter: 'only-expired' })).toBe(true);
    expect(filterRequestsExpired(none)).toBe(false);
    expect(isFilterActive(none)).toBe(false);
    expect(isFilterActive({ ...none, search: '  ' })).toBe(false);
    expect(isFilterActive({ ...none, search: 'x' })).toBe(true);
  });

  it('exposes reusable predicates', () => {
    const state = buildState();
    const token = [...state.tokens.values()][0]!;
    expect(matchesSearch(token, '')).toBe(true);
    expect(matchesQuickFilter(token, 'failed-requests', state.requests)).toBe(true);
  });
});
