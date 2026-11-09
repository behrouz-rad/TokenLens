import type { DiagnosticCheck, DiagnosticSubject, NetworkRequest, SignatureState } from '@/types';
import { getAudienceClaim, getNumericDateClaim, getStringClaim } from '@/core/jwt/decoder';
import { formatDistanceStrict } from 'date-fns';

const SYMMETRIC_ALGORITHMS = new Set(['HS256', 'HS384', 'HS512']);
const ASYMMETRIC_ALGORITHMS = new Set([
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES256K', 'ES384', 'ES512',
  'EdDSA', 'Ed25519', 'Ed448',
]);
const FUTURE_IAT_TOLERANCE_MS = 60 * 1000;

function describeDistance(from: number, to: number): string {
  try {
    return formatDistanceStrict(from, to);
  } catch {
    return 'an unrepresentable amount of time';
  }
}

export function getSignatureState(token: Pick<DiagnosticSubject, 'decoded'>): SignatureState {
  const decoded = token.decoded;
  if (!decoded) return 'unsupported';
  const alg = typeof decoded.header.alg === 'string' ? decoded.header.alg : '';
  if (alg.toLowerCase() === 'none' || !decoded.signaturePresent) return 'unsigned';
  return 'not-verified';
}

export function describeSignatureState(state: SignatureState): string {
  switch (state) {
    case 'not-verified':
      return 'Signature present, not verified';
    case 'unsigned':
      return 'Unsigned';
    case 'unsupported':
      return 'No signature (not a JWT)';
  }
}

function signatureCheck(token: DiagnosticSubject): DiagnosticCheck {
  const decoded = token.decoded;
  const alg = typeof decoded?.header.alg === 'string' ? decoded.header.alg : '';
  const algIsNone = alg.toLowerCase() === 'none';

  if (algIsNone && decoded?.signaturePresent) {
    return {
      id: 'signature',
      label: 'Signature',
      description: 'alg is "none" but a signature segment is present',
      details: 'Conflicting header and structure; a verifier must reject this token.',
      severity: 'error',
    };
  }
  if (algIsNone) {
    return {
      id: 'signature',
      label: 'Signature',
      description: 'Unsigned (alg: none)',
      details: 'Anyone can forge an unsigned token. Production verifiers must reject alg "none".',
      severity: 'error',
    };
  }
  if (!decoded?.signaturePresent) {
    return {
      id: 'signature',
      label: 'Signature',
      description: `Signature segment is empty but alg is "${alg || 'missing'}"`,
      details: 'The token claims to be signed but carries no signature.',
      severity: 'error',
    };
  }
  return {
    id: 'signature',
    label: 'Signature',
    description: 'Signature present, not verified',
    details: 'TokenLens does not verify signatures. A present signature is not evidence of authenticity.',
    severity: 'info',
  };
}

function algorithmCheck(token: DiagnosticSubject): DiagnosticCheck {
  const alg = token.decoded?.header.alg;
  if (typeof alg !== 'string' || alg.length === 0) {
    return {
      id: 'algorithm',
      label: 'Algorithm',
      description: 'Missing alg header parameter',
      details: 'RFC 7515 requires alg. Verifiers cannot determine how to validate this token.',
      severity: 'error',
    };
  }
  if (alg.toLowerCase() === 'none') {
    return { id: 'algorithm', label: 'Algorithm', description: 'none', details: 'Reported under Signature.', severity: 'error' };
  }
  if (SYMMETRIC_ALGORITHMS.has(alg)) {
    return {
      id: 'algorithm',
      label: 'Algorithm',
      description: `${alg} (HMAC, symmetric)`,
      details:
        'Verification requires the shared secret. Appropriate when issuer and verifier are the same trust domain; suitability depends on key management, not the algorithm name.',
      severity: 'info',
    };
  }
  if (ASYMMETRIC_ALGORITHMS.has(alg)) {
    return {
      id: 'algorithm',
      label: 'Algorithm',
      description: `${alg} (asymmetric)`,
      details: 'Verification uses the issuer public key. Recognised algorithm; strength depends on key size and issuer practices.',
      severity: 'info',
    };
  }
  return {
    id: 'algorithm',
    label: 'Algorithm',
    description: `${alg} (unrecognised)`,
    details: 'Not a registered JWS algorithm name. Confirm the verifying library supports it and that it is not a typo.',
    severity: 'warning',
  };
}

function expirationCheck(token: DiagnosticSubject, now: number, expiringThresholdMs: number): DiagnosticCheck {
  const decoded = token.decoded;
  if (!decoded) {
    return { id: 'expiration', label: 'Expiration (exp)', description: 'Not evaluated (no claims)', severity: 'info' };
  }
  const exp = getNumericDateClaim(decoded.payload, 'exp');
  if (exp.kind === 'invalid') {
    return { id: 'expiration', label: 'Expiration (exp)', description: exp.reason, severity: 'error' };
  }
  if (exp.kind === 'absent') {
    return {
      id: 'expiration',
      label: 'Expiration (exp)',
      description: 'No exp claim, lifetime unknown',
      details: 'Expiration was not evaluated. Tokens without exp never expire on their own.',
      severity: 'warning',
    };
  }
  if (exp.ms <= now) {
    return {
      id: 'expiration',
      label: 'Expiration (exp)',
      description: `Expired ${describeDistance(exp.ms, now)} ago`,
      severity: 'error',
    };
  }
  const remaining = describeDistance(now, exp.ms);
  if (exp.ms - now <= expiringThresholdMs) {
    return { id: 'expiration', label: 'Expiration (exp)', description: `Expires in ${remaining}`, severity: 'warning' };
  }
  return { id: 'expiration', label: 'Expiration (exp)', description: `Not expired, expires in ${remaining}`, severity: 'success' };
}

function notBeforeCheck(token: DiagnosticSubject, now: number): DiagnosticCheck | null {
  const decoded = token.decoded;
  if (!decoded) return null;
  const nbf = getNumericDateClaim(decoded.payload, 'nbf');
  if (nbf.kind === 'absent') return null;
  if (nbf.kind === 'invalid') {
    return { id: 'not-before', label: 'Not before (nbf)', description: nbf.reason, severity: 'error' };
  }
  if (nbf.ms > now) {
    return {
      id: 'not-before',
      label: 'Not before (nbf)',
      description: `Not valid for another ${describeDistance(now, nbf.ms)}`,
      severity: 'warning',
    };
  }
  return { id: 'not-before', label: 'Not before (nbf)', description: 'Not-before time has passed', severity: 'success' };
}

function issuedAtCheck(token: DiagnosticSubject, now: number): DiagnosticCheck {
  const decoded = token.decoded;
  if (!decoded) {
    return { id: 'issued-at', label: 'Issued at (iat)', description: 'Not evaluated (no claims)', severity: 'info' };
  }
  const iat = getNumericDateClaim(decoded.payload, 'iat');
  if (iat.kind === 'invalid') {
    return { id: 'issued-at', label: 'Issued at (iat)', description: iat.reason, severity: 'error' };
  }
  if (iat.kind === 'absent') {
    return { id: 'issued-at', label: 'Issued at (iat)', description: 'No iat claim', severity: 'info' };
  }
  const exp = getNumericDateClaim(decoded.payload, 'exp');
  if (exp.kind === 'valid' && iat.ms > exp.ms) {
    return {
      id: 'issued-at',
      label: 'Issued at (iat)',
      description: 'iat is later than exp',
      details: 'The token claims to have been issued after it expired.',
      severity: 'error',
    };
  }
  if (iat.ms > now + FUTURE_IAT_TOLERANCE_MS) {
    return {
      id: 'issued-at',
      label: 'Issued at (iat)',
      description: `Issued ${describeDistance(now, iat.ms)} in the future`,
      details: 'Either the issuer clock or this machine clock is wrong. TokenLens cannot tell which.',
      severity: 'warning',
    };
  }
  return {
    id: 'issued-at',
    label: 'Issued at (iat)',
    description: `Issued ${describeDistance(iat.ms, now)} ago`,
    severity: 'success',
  };
}

function audienceCheck(token: DiagnosticSubject): DiagnosticCheck {
  const decoded = token.decoded;
  const audience = decoded ? getAudienceClaim(decoded.payload) : null;
  if (decoded && 'aud' in decoded.payload && audience === null) {
    return { id: 'audience', label: 'Audience (aud)', description: 'aud has an invalid type', severity: 'error' };
  }
  if (!audience || audience.length === 0) {
    return {
      id: 'audience',
      label: 'Audience (aud)',
      description: 'No aud claim',
      details: 'Without an audience any recipient could accept this token.',
      severity: 'warning',
    };
  }
  return {
    id: 'audience',
    label: 'Audience (aud)',
    description: audience.join(', '),
    details: 'Present. Whether it matches the receiving API was not checked.',
    severity: 'success',
  };
}

function issuerCheck(token: DiagnosticSubject): DiagnosticCheck {
  const decoded = token.decoded;
  if (decoded && 'iss' in decoded.payload && typeof decoded.payload.iss !== 'string') {
    return { id: 'issuer', label: 'Issuer (iss)', description: 'iss has an invalid type', severity: 'error' };
  }
  const issuer = decoded ? getStringClaim(decoded.payload, 'iss') : null;
  if (!issuer) {
    return { id: 'issuer', label: 'Issuer (iss)', description: 'No iss claim', severity: 'warning' };
  }
  return {
    id: 'issuer',
    label: 'Issuer (iss)',
    description: issuer,
    details: 'Present. Issuer trust was not verified.',
    severity: 'success',
  };
}

function keyIdCheck(token: DiagnosticSubject): DiagnosticCheck | null {
  const kid = token.decoded?.header.kid;
  if (typeof kid !== 'string') return null;
  return {
    id: 'key-id',
    label: 'Key ID (kid)',
    description: kid,
    details: 'JWKS retrieval and key matching are not performed by TokenLens.',
    severity: 'info',
  };
}

const CLOCK_SKEW_CHECK: DiagnosticCheck = {
  id: 'clock-skew',
  label: 'Clock skew',
  description: 'Not measured',
  details: 'Requires an independent server time reference, which is not available to the extension.',
  severity: 'info',
};

function claimIssueChecks(token: DiagnosticSubject): DiagnosticCheck[] {
  return (token.decoded?.issues ?? []).map((issue) => ({
    id: `claim-${issue.claim}`,
    label: `Claim "${issue.claim}"`,
    description: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * Token-only checks. They read nothing but the decoded token, so a captured token and a manually
 * decoded one are evaluated by the same rules.
 */
export function runDiagnostics(token: DiagnosticSubject, now: number, expiringThresholdMs: number): DiagnosticCheck[] {
  if (token.format === 'opaque') {
    return [
      {
        id: 'format',
        label: 'Format',
        description: 'Opaque Bearer token',
        details: 'Not a JWT: there are no claims or signature to evaluate. Only the issuing server can interpret it.',
        severity: 'info',
      },
    ];
  }
  if (token.format === 'unsupported') {
    return [
      {
        id: 'format',
        label: 'Format',
        description: token.formatDetail ?? 'Unsupported token format',
        severity: 'warning',
      },
    ];
  }
  if (token.format === 'malformed-jwt') {
    return [
      {
        id: 'format',
        label: 'Format',
        description: 'Malformed JWT',
        details: token.formatDetail ?? undefined,
        severity: 'error',
      },
    ];
  }

  const checks: DiagnosticCheck[] = [
    signatureCheck(token),
    algorithmCheck(token),
    expirationCheck(token, now, expiringThresholdMs),
  ];
  const nbf = notBeforeCheck(token, now);
  if (nbf) checks.push(nbf);
  checks.push(issuedAtCheck(token, now), audienceCheck(token), issuerCheck(token));
  const kid = keyIdCheck(token);
  if (kid) checks.push(kid);
  checks.push(CLOCK_SKEW_CHECK, ...claimIssueChecks(token));
  return checks;
}

/**
 * HTTP evidence only. A 401 or 403 is what the server answered; TokenLens cannot see why,
 * so these checks list possible causes rather than asserting one.
 */
export function runRequestDiagnostics(requests: readonly NetworkRequest[]): DiagnosticCheck[] {
  const unauthorized = requests.filter((r) => r.status === 401).length;
  const forbidden = requests.filter((r) => r.status === 403).length;
  const serverErrors = requests.filter((r) => r.status >= 500).length;
  const checks: DiagnosticCheck[] = [];

  if (unauthorized > 0) {
    checks.push({
      id: 'http-401',
      label: 'HTTP 401 responses',
      description: `${unauthorized} request${unauthorized === 1 ? '' : 's'} rejected as unauthorized`,
      details:
        'Possible causes: expired or not-yet-valid token, audience/issuer mismatch, signature rejected, revoked session. The server did not share its reason.',
      severity: 'warning',
    });
  }
  if (forbidden > 0) {
    checks.push({
      id: 'http-403',
      label: 'HTTP 403 responses',
      description: `${forbidden} request${forbidden === 1 ? '' : 's'} forbidden`,
      details: 'The token was likely accepted but lacks a required scope, role, or permission for that resource.',
      severity: 'warning',
    });
  }
  if (serverErrors > 0) {
    checks.push({
      id: 'http-5xx',
      label: 'HTTP 5xx responses',
      description: `${serverErrors} request${serverErrors === 1 ? '' : 's'} failed on the server`,
      details: 'Server errors are usually unrelated to the token itself.',
      severity: 'info',
    });
  }
  return checks;
}
