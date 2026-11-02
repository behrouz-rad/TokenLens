import { describe, expect, it } from 'vitest';
import { extractAuthorization, harEntryKey, harEntryToObservation } from '@/core/capture/observation';

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
    expect(harEntryKey(entry)).toBe('t|42|GET|u|200|1');
    expect(harEntryKey({ ...entry, _connectionId: undefined, connection: '7' })).toBe('t|7|GET|u|200|1');
    expect(harEntryKey({ ...entry, time: 2 })).not.toBe(harEntryKey(entry));
    expect(harEntryKey({ ...entry, _connectionId: '43' })).not.toBe(harEntryKey(entry));
  });
});
