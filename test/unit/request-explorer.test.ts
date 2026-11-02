import { beforeEach, describe, expect, it } from 'vitest';
import { filterRequests, isRequestFilterActive, matchesRequestSearch, requestHost, statusCategory } from '@/hooks/use-request-explorer';
import { createCaptureState, ingestObservations, applySettings, type CaptureState } from '@/core/capture/session';
import { createSyntheticJwt, resetSyntheticSequence, withBearer } from '@/core/testing/synthetic';
import type { RequestFilter } from '@/types';

const NOW = 1_700_000_000_000;
const seconds = (ms: number) => Math.floor(ms / 1000);
const none: RequestFilter = { search: '', statusCategory: null, tokenId: null };
const opts = { now: NOW, recording: true, clearOnNavigation: false };

const ACCESS = createSyntheticJwt({ alg: 'RS256', typ: 'at+jwt' }, { sub: 'alice', iss: 'https://issuer.example.test', exp: seconds(NOW) + 3600 });
const OTHER = createSyntheticJwt({ alg: 'HS256' }, { sub: 'bob', exp: seconds(NOW) + 3600 });
const OPAQUE = 'opaque-synthetic-0001';

function buildState(): CaptureState {
  return ingestObservations(
    createCaptureState(),
    [
      withBearer(ACCESS, { url: 'https://api.example.test/users', startedAt: NOW - 50_000, durationMs: 120 }),
      withBearer(ACCESS, { url: 'https://api.example.test/orders', method: 'POST', status: 201, startedAt: NOW - 40_000, durationMs: 80 }),
      withBearer(ACCESS, { url: 'https://api.example.test/admin', status: 403, startedAt: NOW - 30_000, durationMs: 15 }),
      withBearer(OTHER, { url: 'https://auth.example.test/redirect', status: 302, startedAt: NOW - 20_000, durationMs: 5 }),
      withBearer(OTHER, { url: 'https://api.example.test/broken', status: 500, startedAt: NOW - 10_000, durationMs: 900 }),
      withBearer(OPAQUE, { url: 'https://oauth.example.test/userinfo', status: 0, startedAt: NOW - 5_000, durationMs: 0 }),
    ],
    opts
  );
}

const tokenByRaw = (state: CaptureState, raw: string) => [...state.tokens.values()].find((t) => t.raw === raw)!;

beforeEach(() => resetSyntheticSequence());

describe('statusCategory', () => {
  it('maps HTTP status codes to classes and leaves pending/unknown statuses unclassified', () => {
    expect(statusCategory(200)).toBe('2xx');
    expect(statusCategory(204)).toBe('2xx');
    expect(statusCategory(302)).toBe('3xx');
    expect(statusCategory(401)).toBe('4xx');
    expect(statusCategory(503)).toBe('5xx');
    expect(statusCategory(599)).toBe('5xx');
    expect(statusCategory(0)).toBeNull();
    expect(statusCategory(600)).toBeNull();
  });
});

describe('requestHost', () => {
  it('extracts the host without constructing a URL and tolerates garbage', () => {
    expect(requestHost('https://API.example.test:8443/path?q=1')).toBe('api.example.test:8443');
    expect(requestHost('chrome-extension://abc/panel.html')).toBe('abc');
    expect(requestHost('not a url')).toBe('');
    expect(requestHost('')).toBe('');
  });
});

describe('filterRequests', () => {
  it('returns every request newest first with its canonical token', () => {
    const state = buildState();
    const rows = filterRequests(state.requests.values(), state.tokens, none);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.request.url.split('/').pop())).toEqual(['userinfo', 'broken', 'redirect', 'admin', 'orders', 'users']);
    for (const row of rows) {
      expect(row.token?.id).toBe(row.request.tokenId);
      expect(row.host).toBe(new URL(row.request.url).host);
    }
  });

  it('filters by status category', () => {
    const state = buildState();
    const statuses = (category: RequestFilter['statusCategory']) =>
      filterRequests(state.requests.values(), state.tokens, { ...none, statusCategory: category }).map((r) => r.request.status);
    expect(statuses('2xx')).toEqual([201, 200]);
    expect(statuses('3xx')).toEqual([302]);
    expect(statuses('4xx')).toEqual([403]);
    expect(statuses('5xx')).toEqual([500]);
  });

  it('filters by token id and reports nothing for an evicted or cleared token', () => {
    const state = buildState();
    const other = tokenByRaw(state, OTHER);
    expect(filterRequests(state.requests.values(), state.tokens, { ...none, tokenId: other.id }).map((r) => r.request.status)).toEqual([500, 302]);
    expect(filterRequests(state.requests.values(), state.tokens, { ...none, tokenId: 'tok-999' })).toEqual([]);
  });

  it('searches URL (including host), method, status, token name and token number case-insensitively', () => {
    const state = buildState();
    const search = (q: string) => filterRequests(state.requests.values(), state.tokens, { ...none, search: q }).length;
    expect(search('ORDERS')).toBe(1);
    expect(search('auth.example.test')).toBe(2);
    expect(search('api.example.test')).toBe(4);
    expect(search('post')).toBe(1);
    expect(search('403')).toBe(1);
    expect(search('access_token')).toBe(3);
    expect(search('bearer_token')).toBe(1);
    expect(search('#2')).toBe(2);
    expect(search('   ')).toBe(6);
    expect(search('zzz-nothing')).toBe(0);
  });

  it('combines search, category and token filters', () => {
    const state = buildState();
    const access = tokenByRaw(state, ACCESS);
    const rows = filterRequests(state.requests.values(), state.tokens, { search: 'example.test', statusCategory: '2xx', tokenId: access.id });
    expect(rows.map((r) => r.request.status)).toEqual([201, 200]);
    expect(isRequestFilterActive(none)).toBe(false);
    expect(isRequestFilterActive({ ...none, search: ' ' })).toBe(false);
    expect(isRequestFilterActive({ ...none, statusCategory: '4xx' })).toBe(true);
    expect(isRequestFilterActive({ ...none, tokenId: 'tok-1' })).toBe(true);
  });

  it('stays consistent after eviction: every remaining row still resolves its token', () => {
    let state = buildState();
    state = applySettings(state, { limits: { maxTokens: 1, maxRequests: 2 } }, NOW);
    const rows = filterRequests(state.requests.values(), state.tokens, none);
    expect(rows.length).toBeLessThanOrEqual(2);
    for (const row of rows) expect(row.token).not.toBeNull();
    expect(state.counters.evictedTokens).toBeGreaterThan(0);
  });

  it('handles thousands of requests quickly', () => {
    const tokens = Array.from({ length: 50 }, (_, i) => createSyntheticJwt({ alg: 'HS256' }, { sub: `bulk-${i}`, exp: seconds(NOW) + 3600 }));
    const observations = Array.from({ length: 5000 }, (_, i) =>
      withBearer(tokens[i % tokens.length]!, { url: `https://api.example.test/bulk/${i}`, status: i % 9 === 0 ? 401 : 200, startedAt: NOW + i })
    );
    const state = ingestObservations(createCaptureState(), observations, opts);
    const started = performance.now();
    const rows = filterRequests(state.requests.values(), state.tokens, { ...none, search: 'bulk', statusCategory: '4xx' });
    expect(performance.now() - started).toBeLessThan(500);
    expect(rows).toHaveLength(Math.ceil(5000 / 9));
    expect(rows[0]!.request.startedAt).toBeGreaterThan(rows[rows.length - 1]!.request.startedAt);
  });

  it('exposes the search predicate for reuse', () => {
    const state = buildState();
    const row = filterRequests(state.requests.values(), state.tokens, none)[0]!;
    expect(matchesRequestSearch(row, '')).toBe(true);
    expect(matchesRequestSearch({ ...row, token: null }, 'bearer_token')).toBe(false);
  });
});
