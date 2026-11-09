import { describe, expect, it } from 'vitest';
import { describeSignatureState, getSignatureState, runDiagnostics, runRequestDiagnostics } from '@/core/diagnostics/engine';
import { createSyntheticJwt } from '@/core/testing/synthetic';
import { buildToken } from '../fixtures/tokens';
import type { DiagnosticCheck, NetworkRequest } from '@/types';

const NOW = 1_700_000_000_000;
const THRESHOLD = 5 * 60 * 1000;
const seconds = (ms: number) => Math.floor(ms / 1000);

function checks(raw: string, now = NOW): Map<string, DiagnosticCheck> {
  const result = runDiagnostics(buildToken(raw, now), now, THRESHOLD);
  return new Map(result.map((c) => [c.id, c]));
}

function jwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256' }, signature?: string) {
  return createSyntheticJwt(header, payload, signature);
}

describe('signature diagnostics', () => {
  it('never reports a present signature as verified', () => {
    const check = checks(jwt({ exp: seconds(NOW) + 3600 })).get('signature');
    expect(check?.severity).toBe('info');
    expect(check?.description).toBe('Signature present, not verified');
    expect(check?.details).toMatch(/does not verify/);
    expect(getSignatureState(buildToken(jwt({}), NOW))).toBe('not-verified');
    expect(describeSignatureState('not-verified')).toBe('Signature present, not verified');
  });

  it('flags alg none as unsigned', () => {
    const check = checks(jwt({}, { alg: 'none' }, '')).get('signature');
    expect(check?.severity).toBe('error');
    expect(check?.description).toMatch(/Unsigned/);
    expect(getSignatureState(buildToken(jwt({}, { alg: 'none' }, ''), NOW))).toBe('unsigned');
  });

  it('flags alg none combined with a signature segment as conflicting', () => {
    const check = checks(jwt({}, { alg: 'none' })).get('signature');
    expect(check?.severity).toBe('error');
    expect(check?.description).toMatch(/signature segment is present/);
  });

  it('flags an empty signature when alg claims the token is signed', () => {
    const check = checks(jwt({}, { alg: 'RS256' }, '')).get('signature');
    expect(check?.severity).toBe('error');
    expect(check?.description).toMatch(/empty/);
  });
});

describe('algorithm diagnostics', () => {
  it('does not treat HS256 as insecure', () => {
    const check = checks(jwt({}, { alg: 'HS256' })).get('algorithm');
    expect(check?.severity).toBe('info');
    expect(check?.description).toMatch(/HS256/);
    expect(check?.details).toMatch(/shared secret/);
  });

  it('does not claim recognised asymmetric algorithms are secure', () => {
    for (const alg of ['RS256', 'ES256', 'PS512', 'EdDSA']) {
      const check = checks(jwt({}, { alg })).get('algorithm');
      expect(check?.severity).toBe('info');
    }
  });

  it('warns on unrecognised algorithms and errors on missing alg', () => {
    expect(checks(jwt({}, { alg: 'HS256X' })).get('algorithm')?.severity).toBe('warning');
    expect(checks(jwt({}, { typ: 'JWT' })).get('algorithm')?.severity).toBe('error');
  });
});

describe('temporal diagnostics', () => {
  it('reports expired, expiring and active tokens distinctly', () => {
    expect(checks(jwt({ exp: seconds(NOW) - 60 })).get('expiration')).toMatchObject({ severity: 'error', description: expect.stringContaining('Expired') });
    expect(checks(jwt({ exp: seconds(NOW) + 60 })).get('expiration')).toMatchObject({ severity: 'warning', description: expect.stringContaining('Expires in') });
    expect(checks(jwt({ exp: seconds(NOW) + 3600 })).get('expiration')).toMatchObject({ severity: 'success', description: expect.stringContaining('Not expired') });
  });

  it('treats a missing exp as not evaluated rather than valid', () => {
    const check = checks(jwt({ sub: 'x' })).get('expiration');
    expect(check?.severity).toBe('warning');
    expect(check?.description).toMatch(/No exp claim/);
    expect(check?.details).toMatch(/not evaluated/);
  });

  it('treats exp = 0 as an expired token', () => {
    expect(checks(jwt({ exp: 0 })).get('expiration')?.severity).toBe('error');
  });

  it('errors on invalid timestamp types', () => {
    expect(checks(jwt({ exp: 'tomorrow' })).get('expiration')?.severity).toBe('error');
    expect(checks(jwt({ nbf: 'later' })).get('not-before')?.severity).toBe('error');
    expect(checks(jwt({ iat: '2024' })).get('issued-at')?.severity).toBe('error');
  });

  it('reports not-yet-valid tokens', () => {
    const check = checks(jwt({ nbf: seconds(NOW) + 120, exp: seconds(NOW) + 3600 })).get('not-before');
    expect(check?.severity).toBe('warning');
    expect(check?.description).toMatch(/Not valid for another/);
    expect(checks(jwt({ nbf: seconds(NOW) - 120 })).get('not-before')?.severity).toBe('success');
    expect(checks(jwt({})).has('not-before')).toBe(false);
  });

  it('warns about a future iat and errors when iat is after exp', () => {
    expect(checks(jwt({ iat: seconds(NOW) + 600 })).get('issued-at')?.severity).toBe('warning');
    expect(checks(jwt({ iat: seconds(NOW) + 30 })).get('issued-at')?.severity).toBe('success');
    expect(checks(jwt({ iat: seconds(NOW), exp: seconds(NOW) - 100 })).get('issued-at')).toMatchObject({ severity: 'error', description: expect.stringContaining('later than exp') });
  });

  it('updates as time passes', () => {
    const raw = jwt({ exp: seconds(NOW) + 600 });
    expect(checks(raw, NOW).get('expiration')?.severity).toBe('success');
    expect(checks(raw, NOW + 400_000).get('expiration')?.severity).toBe('warning');
    expect(checks(raw, NOW + 700_000).get('expiration')?.severity).toBe('error');
  });
});

describe('issuer, audience, key id and clock skew', () => {
  it('warns when iss or aud are missing and does not claim they were verified when present', () => {
    const missing = checks(jwt({}));
    expect(missing.get('audience')?.severity).toBe('warning');
    expect(missing.get('issuer')?.severity).toBe('warning');
    const present = checks(jwt({ iss: 'https://issuer.example.test', aud: ['a', 'b'] }));
    expect(present.get('audience')).toMatchObject({ severity: 'success', description: 'a, b', details: expect.stringContaining('not checked') });
    expect(present.get('issuer')).toMatchObject({ severity: 'success', details: expect.stringContaining('not verified') });
  });

  it('errors on invalid iss and aud types', () => {
    expect(checks(jwt({ iss: 42 })).get('issuer')?.severity).toBe('error');
    expect(checks(jwt({ aud: { x: 1 } })).get('audience')?.severity).toBe('error');
  });

  it('never fabricates JWKS information from a kid', () => {
    const check = checks(jwt({}, { alg: 'RS256', kid: 'key-1' })).get('key-id');
    expect(check?.severity).toBe('info');
    expect(check?.description).toBe('key-1');
    expect(check?.details).toMatch(/not performed/);
    expect(JSON.stringify(check)).not.toMatch(/keys available|loaded/i);
    expect(checks(jwt({})).has('key-id')).toBe(false);
  });

  it('reports clock skew as not measured instead of deriving it from iat', () => {
    const check = checks(jwt({ iat: seconds(NOW) - 3600, exp: seconds(NOW) + 3600 })).get('clock-skew');
    expect(check).toMatchObject({ severity: 'info', description: 'Not measured' });
  });

  it('surfaces claim issues reported by the decoder', () => {
    const result = checks(jwt({ sub: 12 }));
    expect(result.get('claim-sub')).toMatchObject({ severity: 'error' });
  });
});

describe('non-JWT tokens', () => {
  it('describes opaque, malformed and unsupported tokens without temporal claims', () => {
    expect([...checks('opaque-value').values()]).toEqual([expect.objectContaining({ id: 'format', severity: 'info', description: 'Opaque Bearer token' })]);
    expect([...checks('eyJhbGciOiJSUzI1NiJ9.bad.sig').values()]).toEqual([expect.objectContaining({ id: 'format', severity: 'error', description: 'Malformed JWT' })]);
    const jwe = `${createSyntheticJwt({ alg: 'RSA-OAEP' }, {}).split('.')[0]}.a.b.c.d`;
    expect([...checks(jwe).values()]).toEqual([expect.objectContaining({ id: 'format', severity: 'warning' })]);
  });
});

describe('request diagnostics', () => {
  const request = (status: number): NetworkRequest => ({
    id: `r-${status}`,
    url: 'https://api.example.test/x',
    method: 'GET',
    status,
    statusText: '',
    durationMs: 1,
    startedAt: NOW,
    tokenId: 'tok-1',
  });

  it('presents 401/403/5xx as evidence with possible causes, not conclusions', () => {
    const result = runRequestDiagnostics([request(200), request(401), request(401), request(403), request(503)]);
    const byId = new Map(result.map((c) => [c.id, c]));
    expect(byId.get('http-401')).toMatchObject({ severity: 'warning', description: '2 requests rejected as unauthorized', details: expect.stringContaining('Possible causes') });
    expect(byId.get('http-403')).toMatchObject({ severity: 'warning', description: '1 request forbidden' });
    expect(byId.get('http-5xx')).toMatchObject({ severity: 'info' });
    expect(runRequestDiagnostics([request(200), request(201)])).toEqual([]);
  });
});
