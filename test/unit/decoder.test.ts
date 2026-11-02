import { describe, expect, it } from 'vitest';
import {
  analyzeBearerToken,
  classifyToken,
  computeTokenStatus,
  getNumericDateClaim,
  getScopes,
  inferTokenName,
  MAX_CLAIM_DEPTH,
  MAX_TOKEN_LENGTH,
  nextStatusTransition,
} from '@/core/jwt/decoder';
import { utf8ToBase64Url } from '@/core/jwt/base64url';
import { createSyntheticJwt } from '@/core/testing/synthetic';

const NOW = 1_700_000_000_000;
const THRESHOLD = 5 * 60 * 1000;
const seconds = (ms: number) => Math.floor(ms / 1000);

function jwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }, signature?: string) {
  return createSyntheticJwt(header, payload, signature);
}

describe('analyzeBearerToken', () => {
  it('decodes a standard JWT with standard and custom claims', () => {
    const raw = jwt({ iss: 'https://issuer.example.test', sub: 'user-1', exp: seconds(NOW) + 60, custom: { nested: [1, 2, { deep: true }] } });
    const result = analyzeBearerToken(raw);
    expect(result.format).toBe('jwt');
    if (result.format !== 'jwt') return;
    expect(result.decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(result.decoded.payload.sub).toBe('user-1');
    expect(result.decoded.payload.custom).toEqual({ nested: [1, 2, { deep: true }] });
    expect(result.decoded.signaturePresent).toBe(true);
    expect(result.decoded.issues).toEqual([]);
  });

  it('decodes Unicode claim values correctly', () => {
    const raw = jwt({ name: 'Zoë Ångström 🔐', city: '東京' });
    const result = analyzeBearerToken(raw);
    expect(result.format).toBe('jwt');
    expect(result.decoded?.payload.name).toBe('Zoë Ångström 🔐');
    expect(result.decoded?.payload.city).toBe('東京');
  });

  it('strips surrounding whitespace', () => {
    const raw = jwt({ sub: 'x' });
    expect(analyzeBearerToken(`  ${raw}\n`).format).toBe('jwt');
  });

  it('treats empty values as unsupported', () => {
    expect(analyzeBearerToken('')).toMatchObject({ format: 'unsupported', detail: 'Empty token value' });
    expect(analyzeBearerToken('   ')).toMatchObject({ format: 'unsupported' });
  });

  it('classifies values without three segments as opaque', () => {
    expect(analyzeBearerToken('ya29.a0AfH6SMBx').format).toBe('opaque');
    expect(analyzeBearerToken('plain-opaque-token').format).toBe('opaque');
    expect(analyzeBearerToken('a.b').format).toBe('opaque');
    expect(analyzeBearerToken('a.b.c.d').format).toBe('opaque');
  });

  it('treats three-segment values whose header is not a JSON object as opaque', () => {
    expect(analyzeBearerToken('aGVsbG8.d29ybGQ.c2ln').format).toBe('opaque');
    expect(analyzeBearerToken('abc.def.ghi').format).toBe('opaque');
  });

  it('reports a malformed JWT when the header is JSON but the payload is not', () => {
    const raw = `${utf8ToBase64Url('{"alg":"RS256"}')}.not-json-at-all.sig`;
    const result = analyzeBearerToken(raw);
    expect(result.format).toBe('malformed-jwt');
    expect(result.detail).toMatch(/Payload segment/);
  });

  it('reports a malformed JWT when the header looks like JSON but is broken', () => {
    const raw = `eyJhbGciOiJSUzI1NiJ.eyJzdWIiOiJ4In0.sig`;
    const result = analyzeBearerToken(raw);
    expect(result.format).toBe('malformed-jwt');
    expect(result.detail).toMatch(/Header segment/);
  });

  it('reports invalid base64url in the payload', () => {
    const raw = `${utf8ToBase64Url('{"alg":"RS256"}')}.ab+cd/ef.sig`;
    expect(analyzeBearerToken(raw)).toMatchObject({ format: 'malformed-jwt' });
  });

  it('rejects payloads that are JSON but not objects', () => {
    const raw = `${utf8ToBase64Url('{"alg":"RS256"}')}.${utf8ToBase64Url('[1,2,3]')}.sig`;
    expect(analyzeBearerToken(raw)).toMatchObject({ format: 'malformed-jwt', detail: 'Payload segment is not a JSON object' });
    const nullPayload = `${utf8ToBase64Url('{"alg":"RS256"}')}.${utf8ToBase64Url('null')}.sig`;
    expect(analyzeBearerToken(nullPayload).format).toBe('malformed-jwt');
  });

  it('rejects an invalid signature segment', () => {
    const raw = `${utf8ToBase64Url('{"alg":"RS256"}')}.${utf8ToBase64Url('{}')}.sig=with=pad`;
    expect(analyzeBearerToken(raw)).toMatchObject({ format: 'malformed-jwt' });
  });

  it('detects an empty signature segment', () => {
    const raw = jwt({ sub: 'x' }, { alg: 'none' }, '');
    const result = analyzeBearerToken(raw);
    expect(result.format).toBe('jwt');
    expect(result.decoded?.signaturePresent).toBe(false);
  });

  it('flags JWE compact serialisation as unsupported', () => {
    const header = utf8ToBase64Url('{"alg":"RSA-OAEP","enc":"A256GCM"}');
    expect(analyzeBearerToken(`${header}.a.b.c.d`)).toMatchObject({ format: 'unsupported', detail: expect.stringContaining('JWE') });
  });

  it('refuses to decode oversized tokens', () => {
    const raw = `eyJ${'a'.repeat(MAX_TOKEN_LENGTH)}`;
    expect(analyzeBearerToken(raw)).toMatchObject({ format: 'unsupported', detail: expect.stringContaining('exceeds') });
  });

  it('decodes large but valid payloads', () => {
    const big = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`claim_${i}`, 'x'.repeat(10)]));
    const raw = jwt(big);
    expect(raw.length).toBeGreaterThan(30_000);
    const result = analyzeBearerToken(raw);
    expect(result.format).toBe('jwt');
    expect(Object.keys(result.decoded?.payload ?? {})).toHaveLength(1000);
  });

  it('records claim type issues instead of failing', () => {
    // NaN serialises to null, which is an invalid NumericDate and must be reported for iat.
    const result = analyzeBearerToken(jwt({ exp: 'tomorrow', iss: 42, aud: [1], iat: Number.NaN }, { alg: 7 }));
    expect(result.format).toBe('jwt');
    const claims = result.decoded?.issues.map((i) => i.claim).sort();
    expect(claims).toEqual(['alg', 'aud', 'exp', 'iat', 'iss']);
  });

  it('flags a missing alg header', () => {
    const result = analyzeBearerToken(jwt({ sub: 'x' }, { typ: 'JWT' }));
    expect(result.decoded?.issues).toContainEqual({ claim: 'alg', message: expect.stringContaining('missing') });
  });

  it('flags excessively nested payloads', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < MAX_CLAIM_DEPTH + 5; i++) nested = { n: nested };
    const result = analyzeBearerToken(jwt({ nested }));
    expect(result.format).toBe('jwt');
    expect(result.decoded?.issues).toContainEqual({ claim: 'payload', message: expect.stringContaining('nesting') });
  });

  it('never throws for arbitrary input', () => {
    const inputs = ['.', '..', '...', 'eyJ.eyJ.', '\u0000', 'eyJhbGciOiJIUzI1NiJ9..', 'Bearer x', '🔐.🔐.🔐'];
    for (const input of inputs) expect(() => analyzeBearerToken(input)).not.toThrow();
  });
});

describe('getNumericDateClaim', () => {
  it('treats exp = 0, nbf = 0 and iat = 0 as valid epoch values', () => {
    for (const claim of ['exp', 'nbf', 'iat']) {
      expect(getNumericDateClaim({ [claim]: 0 }, claim)).toEqual({ kind: 'valid', seconds: 0, ms: 0 });
    }
  });

  it('distinguishes absent from invalid', () => {
    expect(getNumericDateClaim({}, 'exp')).toEqual({ kind: 'absent' });
    expect(getNumericDateClaim({ exp: '123' }, 'exp').kind).toBe('invalid');
    expect(getNumericDateClaim({ exp: Number.POSITIVE_INFINITY }, 'exp').kind).toBe('invalid');
    expect(getNumericDateClaim({ exp: -1 }, 'exp').kind).toBe('invalid');
    expect(getNumericDateClaim({ exp: null }, 'exp').kind).toBe('invalid');
  });

  it('flags millisecond timestamps as out of range', () => {
    const result = getNumericDateClaim({ exp: NOW + 60_000 }, 'exp');
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).toMatch(/milliseconds/);
  });
});

describe('computeTokenStatus', () => {
  const analyze = (payload: Record<string, unknown>) => analyzeBearerToken(jwt(payload));

  it('returns active, expiring and expired based on exp', () => {
    expect(computeTokenStatus('jwt', analyze({ exp: seconds(NOW) + 3600 }).decoded, NOW, THRESHOLD)).toBe('active');
    expect(computeTokenStatus('jwt', analyze({ exp: seconds(NOW) + 60 }).decoded, NOW, THRESHOLD)).toBe('expiring');
    expect(computeTokenStatus('jwt', analyze({ exp: seconds(NOW) - 1 }).decoded, NOW, THRESHOLD)).toBe('expired');
  });

  it('treats exp = 0 as expired, not as missing', () => {
    expect(computeTokenStatus('jwt', analyze({ exp: 0 }).decoded, NOW, THRESHOLD)).toBe('expired');
  });

  it('treats a missing exp as no-expiry rather than active', () => {
    expect(computeTokenStatus('jwt', analyze({ sub: 'x' }).decoded, NOW, THRESHOLD)).toBe('no-expiry');
  });

  it('treats invalid temporal claims as malformed', () => {
    expect(computeTokenStatus('jwt', analyze({ exp: 'soon' }).decoded, NOW, THRESHOLD)).toBe('malformed');
    expect(computeTokenStatus('jwt', analyze({ nbf: 'later', exp: seconds(NOW) + 3600 }).decoded, NOW, THRESHOLD)).toBe('malformed');
  });

  it('reports not-yet-valid when nbf is in the future', () => {
    expect(computeTokenStatus('jwt', analyze({ nbf: seconds(NOW) + 60, exp: seconds(NOW) + 3600 }).decoded, NOW, THRESHOLD)).toBe('not-yet-valid');
  });

  it('uses no-expiry for opaque and unsupported tokens and malformed for malformed JWTs', () => {
    expect(computeTokenStatus('opaque', null, NOW, THRESHOLD)).toBe('no-expiry');
    expect(computeTokenStatus('unsupported', null, NOW, THRESHOLD)).toBe('no-expiry');
    expect(computeTokenStatus('malformed-jwt', null, NOW, THRESHOLD)).toBe('malformed');
  });

  it('transitions as time passes', () => {
    const decoded = analyze({ exp: seconds(NOW) + 600 }).decoded;
    expect(computeTokenStatus('jwt', decoded, NOW, THRESHOLD)).toBe('active');
    expect(computeTokenStatus('jwt', decoded, NOW + 301_000, THRESHOLD)).toBe('expiring');
    expect(computeTokenStatus('jwt', decoded, NOW + 600_000, THRESHOLD)).toBe('expired');
  });
});

describe('nextStatusTransition', () => {
  it('returns the earliest upcoming boundary', () => {
    const decoded = analyzeBearerToken(jwt({ exp: seconds(NOW) + 600 })).decoded;
    expect(nextStatusTransition('jwt', decoded, NOW, THRESHOLD)).toBe((seconds(NOW) + 600) * 1000 - THRESHOLD);
    expect(nextStatusTransition('jwt', decoded, NOW + 400_000, THRESHOLD)).toBe((seconds(NOW) + 600) * 1000);
    expect(nextStatusTransition('jwt', decoded, NOW + 700_000, THRESHOLD)).toBeNull();
  });

  it('includes nbf boundaries and ignores non-JWTs', () => {
    const decoded = analyzeBearerToken(jwt({ nbf: seconds(NOW) + 30, exp: seconds(NOW) + 3600 })).decoded;
    expect(nextStatusTransition('jwt', decoded, NOW, THRESHOLD)).toBe((seconds(NOW) + 30) * 1000);
    expect(nextStatusTransition('opaque', null, NOW, THRESHOLD)).toBeNull();
  });
});

describe('classifyToken', () => {
  it('recognises RFC 9068 access tokens by typ', () => {
    const analysis = analyzeBearerToken(jwt({ sub: 'x' }, { alg: 'RS256', typ: 'at+jwt' }));
    expect(classifyToken(analysis)).toMatchObject({ type: 'JWT (Access)', basis: expect.stringContaining('RFC 9068') });
    const mediaType = analyzeBearerToken(jwt({ sub: 'x' }, { alg: 'RS256', typ: 'application/at+jwt' }));
    expect(classifyToken(mediaType).type).toBe('JWT (Access)');
  });

  it('recognises OIDC ID tokens by their specific claims, not by the openid scope', () => {
    expect(classifyToken(analyzeBearerToken(jwt({ nonce: 'abc' }))).type).toBe('JWT (ID)');
    expect(classifyToken(analyzeBearerToken(jwt({ at_hash: 'abc' }))).type).toBe('JWT (ID)');
    expect(classifyToken(analyzeBearerToken(jwt({ scope: 'openid profile', sub: 'x', iss: 'y', exp: 1 }))).type).toBe('JWT');
  });

  it('falls back to a generic JWT with an explanatory basis', () => {
    const classification = classifyToken(analyzeBearerToken(jwt({ sub: 'x', scope: 'read', iss: 'y', exp: 1 })));
    expect(classification.type).toBe('JWT');
    expect(classification.basis).toMatch(/No standards-based/);
  });

  it('labels non-JWT formats', () => {
    expect(classifyToken(analyzeBearerToken('opaque')).type).toBe('Bearer (opaque)');
    expect(classifyToken(analyzeBearerToken('eyJhbGciOiJSUzI1NiJ9.bad.sig')).type).toBe('Malformed JWT');
    expect(classifyToken(analyzeBearerToken('')).type).toBe('Unsupported');
  });

  it('derives generic names from the type', () => {
    expect(inferTokenName('JWT (Access)')).toBe('access_token');
    expect(inferTokenName('JWT (ID)')).toBe('id_token');
    expect(inferTokenName('Bearer (opaque)')).toBe('bearer_token');
  });
});

describe('getScopes', () => {
  it('reads space-delimited scope strings and scp arrays', () => {
    expect(getScopes({ scope: 'a  b c' })).toEqual(['a', 'b', 'c']);
    expect(getScopes({ scp: ['x', 1, 'y'] })).toEqual(['x', 'y']);
    expect(getScopes({})).toEqual([]);
  });
});
