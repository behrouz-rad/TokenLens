import { describe, expect, it } from 'vitest';
import { inspectCredentialInput, normalizeCredentialInput, toDiagnosticSubject } from '@/core/jwt/credential-input';
import { MAX_TOKEN_LENGTH } from '@/core/jwt/decoder';
import { utf8ToBase64Url } from '@/core/jwt/base64url';
import { runDiagnostics } from '@/core/diagnostics/engine';
import { createSyntheticJwt, SYNTHETIC_SIGNATURE } from '@/core/testing/synthetic';

const NOW = 1_700_000_000_000;
const THRESHOLD = 5 * 60 * 1000;
const seconds = (ms: number) => Math.floor(ms / 1000);
const JWT = createSyntheticJwt({ alg: 'RS256', typ: 'JWT' }, { iss: 'https://issuer.example.test', sub: 'user-1', exp: seconds(NOW) + 3600 });

function analyzed(input: string) {
  const result = inspectCredentialInput(input);
  if (result.state !== 'analyzed') throw new Error(`expected an analyzed result, got ${result.state}`);
  return result;
}

describe('normalizeCredentialInput', () => {
  it('accepts a raw compact JWT unchanged', () => {
    expect(normalizeCredentialInput(JWT)).toEqual({ credential: JWT, hints: [] });
  });

  it.each(['Bearer ', 'bearer ', 'BEARER ', 'Bearer\t', 'Bearer   '])('removes the %j scheme prefix case-insensitively', (prefix) => {
    expect(normalizeCredentialInput(`${prefix}${JWT}`)).toEqual({ credential: JWT, hints: [{ kind: 'bearer-prefix-removed' }] });
  });

  it('ignores leading and trailing whitespace, including line breaks', () => {
    expect(normalizeCredentialInput(`\n  Bearer ${JWT}  \r\n`)).toEqual({
      credential: JWT,
      hints: [{ kind: 'bearer-prefix-removed' }, { kind: 'surrounding-whitespace-ignored' }],
    });
  });

  it('keeps internal whitespace and reports it instead of repairing the token', () => {
    const wrapped = `${JWT.slice(0, 20)}\n${JWT.slice(20)}`;
    const result = normalizeCredentialInput(wrapped);
    expect(result?.credential).toBe(wrapped);
    expect(result?.hints).toEqual([{ kind: 'internal-whitespace' }]);
  });

  it('does not treat a word that merely starts with "Bearer" as the scheme', () => {
    expect(normalizeCredentialInput('Bearerish-token')?.credential).toBe('Bearerish-token');
  });

  it('returns null for empty input and for the scheme alone', () => {
    expect(normalizeCredentialInput('')).toBeNull();
    expect(normalizeCredentialInput('   \n')).toBeNull();
    expect(normalizeCredentialInput('Bearer')).toBeNull();
    expect(normalizeCredentialInput('  bearer   ')).toBeNull();
  });
});

describe('inspectCredentialInput', () => {
  it('reports empty and scheme-only input without analysing anything', () => {
    expect(inspectCredentialInput('')).toEqual({ state: 'empty' });
    expect(inspectCredentialInput(' \t ')).toEqual({ state: 'empty' });
    expect(inspectCredentialInput('Bearer ')).toEqual({ state: 'scheme-only' });
  });

  it('decodes a raw JWT and a Bearer-prefixed JWT to the same result', () => {
    const raw = analyzed(JWT);
    const prefixed = analyzed(`  Bearer ${JWT}\n`);
    expect(raw.credential).toBe(JWT);
    expect(prefixed.credential).toBe(JWT);
    expect(prefixed.analysis).toEqual(raw.analysis);
    expect(raw.analysis.format).toBe('jwt');
    expect(raw.classification.type).toBe('JWT');
    expect(raw.analysis.decoded?.payload).toMatchObject({ iss: 'https://issuer.example.test', sub: 'user-1' });
  });

  it('decodes Unicode, nested objects and arrays', () => {
    const payload = { sub: 'ünïcødé', name: 'Zoë 🔐 東京', org: { id: 'o-1', tags: ['a', 'b', { deep: [1, 2] }] } };
    const result = analyzed(createSyntheticJwt({ alg: 'ES256' }, payload));
    expect(result.analysis.decoded?.payload).toEqual(payload);
    expect(result.json?.payload).toBe(JSON.stringify(payload));
  });

  it('keeps the header and payload JSON text exactly as encoded, so nothing is lost in Raw view', () => {
    const headerText = '{"typ":"JWT","alg":"HS256"}';
    const payloadText = '{\n  "big": 12345678901234567890,\n  "dup": 1,\n  "dup": 2\n}';
    const token = `${utf8ToBase64Url(headerText)}.${utf8ToBase64Url(payloadText)}.${SYNTHETIC_SIGNATURE}`;
    const result = analyzed(token);
    expect(result.json).toEqual({ header: headerText, payload: payloadText });
    expect(result.analysis.decoded?.payload.dup).toBe(2);
  });

  it('classifies a malformed JWT with the decoder detail', () => {
    const invalidBase64 = analyzed('eyJhbGciOiJSUzI1NiJ9.!!!.sig');
    expect(invalidBase64.analysis.format).toBe('malformed-jwt');
    expect(invalidBase64.analysis.detail).toMatch(/Payload segment/);
    expect(invalidBase64.json).toBeNull();

    const invalidJson = analyzed(`${utf8ToBase64Url('{"alg":"HS256"}')}.${utf8ToBase64Url('{not json')}.${SYNTHETIC_SIGNATURE}`);
    expect(invalidJson.analysis.format).toBe('malformed-jwt');
    expect(invalidJson.analysis.detail).toBe('Payload segment is not valid JSON');
  });

  it('reports a JWT broken by an inserted line break as malformed and explains the whitespace', () => {
    const [header, payload, signature] = JWT.split('.');
    const result = analyzed(`${header}.${payload!.slice(0, 10)}\n${payload!.slice(10)}.${signature}`);
    expect(result.analysis.format).toBe('malformed-jwt');
    expect(result.hints).toContainEqual({ kind: 'internal-whitespace' });
  });

  it('keeps opaque tokens opaque and points out a JWT-like value with missing segments', () => {
    const opaque = analyzed('opaque-synthetic-token-0001');
    expect(opaque.analysis.format).toBe('opaque');
    expect(opaque.hints).toEqual([]);

    const [header, payload] = JWT.split('.');
    const truncated = analyzed(`${header}.${payload}`);
    expect(truncated.analysis.format).toBe('opaque');
    expect(truncated.analysis.decoded).toBeNull();
    expect(truncated.hints).toEqual([{ kind: 'jwt-like-segment-count', segments: 2 }]);
  });

  it('recognises JWE as unsupported and never decodes it', () => {
    const jwe = [utf8ToBase64Url('{"alg":"RSA-OAEP","enc":"A256GCM"}'), 'a2V5', 'aXY', 'Y2lwaGVydGV4dA', 'dGFn'].join('.');
    const result = analyzed(jwe);
    expect(result.analysis.format).toBe('unsupported');
    expect(result.analysis.detail).toMatch(/JWE/);
    expect(result.analysis.decoded).toBeNull();
    expect(result.json).toBeNull();
  });

  it('decodes unsigned tokens and lets diagnostics flag them', () => {
    const result = analyzed(createSyntheticJwt({ alg: 'none' }, { sub: 'x' }, ''));
    expect(result.analysis.format).toBe('jwt');
    expect(result.analysis.decoded?.signaturePresent).toBe(false);
    const signature = runDiagnostics(toDiagnosticSubject(result.analysis), NOW, THRESHOLD).find((c) => c.id === 'signature');
    expect(signature).toMatchObject({ severity: 'error', description: 'Unsigned (alg: none)' });
  });

  it('reports incorrectly typed temporal claims like the capture path does', () => {
    const result = analyzed(createSyntheticJwt({ alg: 'HS256' }, { exp: '2030-01-01', nbf: 1e15 }));
    const checks = runDiagnostics(toDiagnosticSubject(result.analysis), NOW, THRESHOLD);
    expect(checks.find((c) => c.id === 'expiration')).toMatchObject({ severity: 'error', description: 'exp must be a NumericDate (finite number of seconds)' });
    expect(checks.find((c) => c.id === 'not-before')?.description).toMatch(/milliseconds/);
  });

  it('reports input above the size limit explicitly and keeps the whole credential', () => {
    const huge = `eyJ${'a'.repeat(MAX_TOKEN_LENGTH)}`;
    const result = inspectCredentialInput(`Bearer ${huge}`);
    expect(result).toMatchObject({ state: 'too-large', length: huge.length, limit: MAX_TOKEN_LENGTH });
    if (result.state !== 'too-large') return;
    expect(result.credential).toBe(huge);
  });

  it('accepts a credential exactly at the limit', () => {
    expect(inspectCredentialInput('x'.repeat(MAX_TOKEN_LENGTH)).state).toBe('analyzed');
  });
});
