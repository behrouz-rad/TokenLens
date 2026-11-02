import { z } from 'zod';
import type { ClaimIssue, DecodedToken, JwtHeader, JwtPayload, TokenFormat, TokenStatus, TokenType } from '@/types';
import { Base64UrlError, base64UrlToUtf8, isBase64Url } from './base64url';

export const MAX_TOKEN_LENGTH = 64 * 1024;
export const MAX_CLAIM_DEPTH = 64;
/** 253402300799 is 9999-12-31T23:59:59Z. Larger values are almost always millisecond timestamps. */
const MAX_NUMERIC_DATE_SECONDS = 253402300799;

const JsonObjectSchema = z.record(z.string(), z.unknown());

export type TokenAnalysis =
  | { format: 'jwt'; decoded: DecodedToken; detail: null }
  | { format: 'malformed-jwt'; decoded: null; detail: string }
  | { format: 'unsupported'; decoded: null; detail: string }
  | { format: 'opaque'; decoded: null; detail: null };

export type NumericDateClaim =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; seconds: number; ms: number };

export function getNumericDateClaim(payload: JwtPayload, claim: string): NumericDateClaim {
  if (!(claim in payload)) return { kind: 'absent' };
  const value = payload[claim];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { kind: 'invalid', reason: `${claim} must be a NumericDate (finite number of seconds)` };
  }
  if (value < 0) return { kind: 'invalid', reason: `${claim} is negative` };
  if (value > MAX_NUMERIC_DATE_SECONDS) {
    return { kind: 'invalid', reason: `${claim} is out of range (looks like milliseconds instead of seconds)` };
  }
  return { kind: 'valid', seconds: value, ms: value * 1000 };
}

export function getStringClaim(payload: JwtPayload, claim: string): string | null {
  const value = payload[claim];
  return typeof value === 'string' ? value : null;
}

export function getAudienceClaim(payload: JwtPayload): string[] | null {
  const value = payload.aud;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) return value;
  return null;
}

export function getScopes(payload: JwtPayload): string[] {
  const scope = payload.scope ?? payload.scp;
  if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === 'string');
  return [];
}

function measureDepth(value: unknown, depth = 0): number {
  if (depth > MAX_CLAIM_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) max = Math.max(max, measureDepth(item, depth + 1));
    return max;
  }
  if (value !== null && typeof value === 'object') {
    let max = depth;
    for (const item of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, measureDepth(item, depth + 1));
    }
    return max;
  }
  return depth;
}

function collectClaimIssues(header: JwtHeader, payload: JwtPayload): ClaimIssue[] {
  const issues: ClaimIssue[] = [];

  if (!('alg' in header)) {
    issues.push({ claim: 'alg', message: 'Header is missing the alg parameter' });
  } else if (typeof header.alg !== 'string') {
    issues.push({ claim: 'alg', message: 'alg must be a string' });
  }
  if ('typ' in header && typeof header.typ !== 'string') {
    issues.push({ claim: 'typ', message: 'typ must be a string' });
  }
  if ('kid' in header && typeof header.kid !== 'string') {
    issues.push({ claim: 'kid', message: 'kid must be a string' });
  }

  for (const claim of ['exp', 'nbf', 'iat']) {
    const result = getNumericDateClaim(payload, claim);
    if (result.kind === 'invalid') issues.push({ claim, message: result.reason });
  }
  for (const claim of ['iss', 'sub', 'jti']) {
    if (claim in payload && typeof payload[claim] !== 'string') {
      issues.push({ claim, message: `${claim} must be a string` });
    }
  }
  if ('aud' in payload && getAudienceClaim(payload) === null) {
    issues.push({ claim: 'aud', message: 'aud must be a string or an array of strings' });
  }
  if (measureDepth(payload) > MAX_CLAIM_DEPTH) {
    issues.push({ claim: 'payload', message: `Payload nesting exceeds ${MAX_CLAIM_DEPTH} levels` });
  }
  return issues;
}

function decodeJsonSegment(segment: string, name: string): Record<string, unknown> {
  let text: string;
  try {
    text = base64UrlToUtf8(segment);
  } catch (error) {
    const reason = error instanceof Base64UrlError ? error.message : 'invalid encoding';
    throw new Error(`${name} segment: ${reason}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} segment is not valid JSON`, { cause: error });
  }
  const result = JsonObjectSchema.safeParse(parsed);
  if (!result.success || Array.isArray(parsed)) {
    throw new Error(`${name} segment is not a JSON object`);
  }
  return result.data;
}

function looksLikeJwtHeader(segment: string): boolean {
  return segment.startsWith('eyJ');
}

/**
 * Classifies a raw Bearer value without assuming it is a JWT. A three-segment value is only
 * reported as a malformed JWT when its first segment is recognisably a JSON header; any other
 * dotted string is an opaque token the server understands and TokenLens cannot.
 */
export function analyzeBearerToken(raw: string): TokenAnalysis {
  const value = raw.trim();
  if (value.length === 0) {
    return { format: 'unsupported', decoded: null, detail: 'Empty token value' };
  }
  if (value.length > MAX_TOKEN_LENGTH) {
    return {
      format: 'unsupported',
      decoded: null,
      detail: `Token exceeds ${MAX_TOKEN_LENGTH / 1024} KiB and was not decoded`,
    };
  }

  const segments = value.split('.');

  if (segments.length === 5 && segments.every(isBase64Url) && looksLikeJwtHeader(segments[0] ?? '')) {
    return {
      format: 'unsupported',
      decoded: null,
      detail: 'JWE (encrypted JWT): contents cannot be inspected without the decryption key',
    };
  }

  if (segments.length !== 3) {
    return { format: 'opaque', decoded: null, detail: null };
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const headerLooksJwt = looksLikeJwtHeader(headerSegment);

  let header: JwtHeader;
  try {
    header = decodeJsonSegment(headerSegment, 'Header');
  } catch (error) {
    if (!headerLooksJwt) return { format: 'opaque', decoded: null, detail: null };
    return { format: 'malformed-jwt', decoded: null, detail: (error as Error).message };
  }

  let payload: JwtPayload;
  try {
    payload = decodeJsonSegment(payloadSegment, 'Payload');
  } catch (error) {
    return { format: 'malformed-jwt', decoded: null, detail: (error as Error).message };
  }

  if (!isBase64Url(signatureSegment)) {
    return {
      format: 'malformed-jwt',
      decoded: null,
      detail: 'Signature segment contains characters outside the base64url alphabet',
    };
  }

  return {
    format: 'jwt',
    decoded: {
      header,
      payload,
      segments: [headerSegment, payloadSegment, signatureSegment],
      signaturePresent: signatureSegment.length > 0,
      issues: collectClaimIssues(header, payload),
    },
    detail: null,
  };
}

export interface TokenClassification {
  type: TokenType;
  basis: string;
}

const OIDC_ID_TOKEN_CLAIMS = ['nonce', 'at_hash', 'c_hash'];

/**
 * Token type inference is heuristic and transparent: `basis` explains every decision so the UI
 * never presents a guess as a verified fact. Only standards-based indicators are used.
 */
export function classifyToken(analysis: TokenAnalysis): TokenClassification {
  switch (analysis.format) {
    case 'opaque':
      return { type: 'Bearer (opaque)', basis: 'Not a JWT; opaque value understood only by the issuing server' };
    case 'malformed-jwt':
      return { type: 'Malformed JWT', basis: analysis.detail };
    case 'unsupported':
      return { type: 'Unsupported', basis: analysis.detail };
    case 'jwt': {
      const { header, payload } = analysis.decoded;
      const typ = typeof header.typ === 'string' ? header.typ.toLowerCase() : '';
      if (typ === 'at+jwt' || typ === 'application/at+jwt') {
        return { type: 'JWT (Access)', basis: 'Header typ is at+jwt (RFC 9068 access token)' };
      }
      const idClaim = OIDC_ID_TOKEN_CLAIMS.find((claim) => typeof payload[claim] === 'string');
      if (idClaim) {
        return { type: 'JWT (ID)', basis: `Contains the OIDC ID token claim "${idClaim}"` };
      }
      return { type: 'JWT', basis: 'No standards-based type indicator (typ or OIDC claims); shown as generic JWT' };
    }
  }
}

export function inferTokenName(type: TokenType): string {
  switch (type) {
    case 'JWT (Access)':
      return 'access_token';
    case 'JWT (ID)':
      return 'id_token';
    case 'JWT':
      return 'jwt_token';
    case 'Bearer (opaque)':
      return 'bearer_token';
    case 'Malformed JWT':
      return 'malformed_token';
    case 'Unsupported':
      return 'unsupported_token';
  }
}

export interface TemporalBounds {
  expiresAt: number | null;
  notBeforeAt: number | null;
}

export function getTemporalBounds(decoded: DecodedToken | null): TemporalBounds {
  if (!decoded) return { expiresAt: null, notBeforeAt: null };
  const exp = getNumericDateClaim(decoded.payload, 'exp');
  const nbf = getNumericDateClaim(decoded.payload, 'nbf');
  return {
    expiresAt: exp.kind === 'valid' ? exp.ms : null,
    notBeforeAt: nbf.kind === 'valid' ? nbf.ms : null,
  };
}

/**
 * Temporal status only. It says nothing about signature validity: an "active" token is merely
 * one whose exp/nbf claims place the current time inside its declared validity window.
 */
export function computeTokenStatus(
  format: TokenFormat,
  decoded: DecodedToken | null,
  now: number,
  expiringThresholdMs: number
): TokenStatus {
  if (format === 'malformed-jwt') return 'malformed';
  if (format !== 'jwt' || !decoded) return 'no-expiry';

  const exp = getNumericDateClaim(decoded.payload, 'exp');
  const nbf = getNumericDateClaim(decoded.payload, 'nbf');
  if (exp.kind === 'invalid' || nbf.kind === 'invalid') return 'malformed';
  if (nbf.kind === 'valid' && nbf.ms > now) return 'not-yet-valid';
  if (exp.kind === 'absent') return 'no-expiry';
  if (exp.ms <= now) return 'expired';
  if (exp.ms - now <= expiringThresholdMs) return 'expiring';
  return 'active';
}

/** Earliest future instant at which `computeTokenStatus` could return a different value. */
export function nextStatusTransition(
  format: TokenFormat,
  decoded: DecodedToken | null,
  now: number,
  expiringThresholdMs: number
): number | null {
  if (format !== 'jwt' || !decoded) return null;
  const exp = getNumericDateClaim(decoded.payload, 'exp');
  const nbf = getNumericDateClaim(decoded.payload, 'nbf');
  const candidates: number[] = [];
  if (nbf.kind === 'valid' && nbf.ms > now) candidates.push(nbf.ms);
  if (exp.kind === 'valid') {
    if (exp.ms - expiringThresholdMs > now) candidates.push(exp.ms - expiringThresholdMs);
    if (exp.ms > now) candidates.push(exp.ms);
  }
  return candidates.length ? Math.min(...candidates) : null;
}
