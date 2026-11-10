import { describe, expect, it } from 'vitest';
import { extractAuthorization, harEntryKey, harEntryRequestIdentity, harEntryToObservation, isHarEntryInFlight } from '@/core/capture/observation';

describe('extractAuthorization', () => {
  it('extracts Bearer tokens case-insensitively from header name and scheme', () => {
    expect(extractAuthorization([{ name: 'Authorization', value: 'Bearer abc.def.ghi' }])).toEqual({ scheme: 'bearer', bearerToken: 'abc.def.ghi' });
    expect(extractAuthorization([{ name: 'AUTHORIZATION', value: 'bearer  token  ' }])).toEqual({ scheme: 'bearer', bearerToken: 'token' });
    expect(extractAuthorization([{ name: 'authorization', value: 'BEARER x' }])).toEqual({ scheme: 'bearer', bearerToken: 'x' });
  });

  it('reports other schemes without retaining their value', () => {
    const result = extractAuthorization([{ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' }]);
    expect(result).toEqual({ scheme: 'other', bearerToken: null });
    expect(JSON.stringify(result)).not.toContain('dXNlcjpwYXNz');
  });

  it('returns nothing for missing, empty or bare Bearer headers', () => {
    expect(extractAuthorization(undefined)).toEqual({ scheme: null, bearerToken: null });
    expect(extractAuthorization([{ name: 'Cookie', value: 'a=b' }])).toEqual({ scheme: null, bearerToken: null });
    expect(extractAuthorization([{ name: 'Authorization', value: '' }])).toEqual({ scheme: null, bearerToken: null });
    expect(extractAuthorization([{ name: 'Authorization', value: 'Bearer' }])).toEqual({ scheme: 'other', bearerToken: null });
    expect(extractAuthorization([{ name: 'Authorization', value: 'Bearer   ' }])).toEqual({ scheme: 'other', bearerToken: null });
  });
});

describe('harEntryToObservation', () => {
  it('uses HAR timestamps and drops every header except the Bearer credential', () => {
    const observation = harEntryToObservation(
      {
        startedDateTime: '2024-01-02T03:04:05.678Z',
        time: 123.4,
        request: {
          method: 'post',
          url: 'https://api.example.test/items',
          headers: [
            { name: 'Cookie', value: 'session=secret' },
            { name: 'Authorization', value: 'Bearer tok' },
            { name: 'X-Custom', value: 'y' },
          ],
        },
        response: { status: 201, statusText: 'Created' },
      },
      1
    );
    expect(observation).toEqual({
      kind: 'request',
      url: 'https://api.example.test/items',
      method: 'POST',
      status: 201,
      statusText: 'Created',
      startedAt: Date.parse('2024-01-02T03:04:05.678Z'),
      durationMs: 123.4,
      bearerToken: 'tok',
      authorizationScheme: 'bearer',
    });
    expect(JSON.stringify(observation)).not.toContain('session=secret');
  });

  it('falls back to the receive time and safe defaults for missing or malformed fields', () => {
    const observation = harEntryToObservation({ startedDateTime: 'not-a-date', time: -5, request: {}, response: {} }, 42);
    expect(observation).toMatchObject({ url: '', method: 'GET', status: 0, statusText: '', startedAt: 42, durationMs: 0, bearerToken: null });
    expect(harEntryToObservation({}, 7).startedAt).toBe(7);
  });
});

describe('harEntryKey', () => {
  it('prefers the private request id and otherwise builds a composite key', () => {
    expect(harEntryKey({ _requestId: '123.4' })).toBe('id:123.4');
    const entry = { startedDateTime: 't', time: 1, _connectionId: '42', request: { method: 'GET', url: 'u' }, response: { status: 200 } };
    expect(harEntryKey(entry)).toBe('t|42|GET|u|200||1');
    expect(harEntryKey({ ...entry, _connectionId: undefined, connection: '7' })).toBe('t|7|GET|u|200||1');
    expect(harEntryKey({ ...entry, time: 2 })).not.toBe(harEntryKey(entry));
    expect(harEntryKey({ ...entry, _connectionId: '43' })).not.toBe(harEntryKey(entry));
  });

  it('stays the same while a completed response finishes loading, and separates distinct requests', () => {
    const phases = { blocked: 44.78, _blocked_queueing: 44.28, dns: -1, connect: -1, ssl: -1, send: 0.08, wait: 12.65 };
    const early = { startedDateTime: 't', time: 59.4, _connectionId: '137', request: { method: 'GET', url: 'u' }, response: { status: 200, _error: null }, timings: { ...phases, receive: 1.89 } };
    const final = { ...early, time: 58.06, timings: { ...phases, receive: 0.55 } };
    expect(harEntryKey(final)).toBe(harEntryKey(early));
    expect(harEntryKey({ ...final, timings: { ...phases, blocked: 58.11, receive: 0.55 } })).not.toBe(harEntryKey(final));
    expect(harEntryKey({ ...final, response: { status: 401, _error: null } })).not.toBe(harEntryKey(final));
    const refused = { startedDateTime: 't', time: 6.2, request: { method: 'GET', url: 'u' }, response: { status: 0, _error: 'net::ERR_CONNECTION_REFUSED' }, timings: { blocked: 0, send: 0, wait: 0, receive: 0 } };
    expect(harEntryKey({ ...refused, time: 7.9 })).not.toBe(harEntryKey(refused));
  });
});

describe('isHarEntryInFlight', () => {
  it('recognises in-flight entries without mistaking failed, cancelled or blocked requests for them', () => {
    const request = { method: 'GET', url: 'u' };
    expect(isHarEntryInFlight({ time: 0, request, response: { status: 0, statusText: '', _error: null } })).toBe(true);
    expect(isHarEntryInFlight({ time: 0, request, response: {} })).toBe(true);
    expect(isHarEntryInFlight({ time: 6.2, request, response: { status: 0, _error: 'net::ERR_CONNECTION_REFUSED' } })).toBe(false);
    expect(isHarEntryInFlight({ time: 702.9, request, response: { status: 0, _error: 'net::ERR_ABORTED' } })).toBe(false);
    expect(isHarEntryInFlight({ time: 82.9, request, response: { status: 200, _error: 'net::ERR_FAILED' } })).toBe(false);
    expect(isHarEntryInFlight({ time: 58.1, request, response: { status: 200, _error: null } })).toBe(false);
  });
});

describe('harEntryRequestIdentity', () => {
  it('stays the same through every snapshot of a request, and cannot tell same-millisecond twins apart', () => {
    const request = { method: 'GET', url: 'https://api.example.test/stream' };
    const inFlight = { startedDateTime: 't', time: 0, request, response: { status: 0, _error: null }, timings: { blocked: -129_855_013.88, wait: 0, receive: 0 } };
    const early = { startedDateTime: 't', time: 59.4, _connectionId: '137', request, response: { status: 200, _error: null }, timings: { blocked: 44.78, wait: 12.65, receive: 1.89 } };
    const dropped = { ...early, time: 939.3, response: { status: 200, _error: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' } };
    const cancelled = { startedDateTime: 't', time: 913.7, request, response: { status: 0, _error: 'net::ERR_ABORTED' }, timings: { blocked: 913.68, wait: 0, receive: 0 } };
    const identities = new Set([inFlight, early, dropped, cancelled].map(harEntryRequestIdentity));
    expect(identities.size).toBe(1);
    expect(harEntryKey(dropped)).not.toBe(harEntryKey(early));
    expect(harEntryRequestIdentity({ ...early, timings: { blocked: 58.11, wait: 16.69, receive: 0.85 } })).toBe(harEntryRequestIdentity(early));
    expect(harEntryRequestIdentity({ ...early, startedDateTime: 'u' })).not.toBe(harEntryRequestIdentity(early));
  });
});
