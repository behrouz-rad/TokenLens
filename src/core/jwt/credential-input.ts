import type { DiagnosticSubject } from '@/types';
import { analyzeBearerToken, classifyToken, MAX_TOKEN_LENGTH, type TokenAnalysis, type TokenClassification } from './decoder';
import { base64UrlToUtf8 } from './base64url';

const BEARER_PREFIX = /^bearer(?:\s+|$)/i;
const INTERNAL_WHITESPACE = /\s/;

export type CredentialInputHint =
  | { kind: 'bearer-prefix-removed' }
  | { kind: 'surrounding-whitespace-ignored' }
  | { kind: 'internal-whitespace' }
  | { kind: 'jwt-like-segment-count'; segments: number };

/**
 * A manually entered credential, separated from the text the user typed. Only the Bearer scheme
 * and surrounding whitespace are removed; nothing inside the credential is changed, so a damaged
 * token is reported as damaged instead of being silently repaired.
 */
export type CredentialInspection =
  | { state: 'empty' }
  | { state: 'scheme-only' }
  | { state: 'too-large'; credential: string; hints: CredentialInputHint[]; length: number; limit: number }
  | {
      state: 'analyzed';
      credential: string;
      hints: CredentialInputHint[];
      analysis: TokenAnalysis;
      classification: TokenClassification;
      /**
       * The header and payload exactly as encoded in the token. `analysis.decoded` holds the parsed
       * objects, which normalise key order, duplicate keys and large integers; this keeps the original
       * text so a Raw view and copy lose nothing.
       */
      json: { header: string; payload: string } | null;
    };

export const EMPTY_INSPECTION: CredentialInspection = { state: 'empty' };

/** Strips a case-insensitive `Bearer ` scheme and surrounding whitespace; returns null when nothing is left. */
export function normalizeCredentialInput(input: string): { credential: string; hints: CredentialInputHint[] } | null {
  const trimmed = input.trim();
  const hints: CredentialInputHint[] = [];
  let credential = trimmed;
  const prefix = BEARER_PREFIX.exec(trimmed);
  if (prefix) {
    credential = trimmed.slice(prefix[0].length);
    hints.push({ kind: 'bearer-prefix-removed' });
  }
  if (credential.length === 0) return null;
  if (trimmed.length !== input.length) hints.push({ kind: 'surrounding-whitespace-ignored' });
  if (INTERNAL_WHITESPACE.test(credential)) hints.push({ kind: 'internal-whitespace' });
  return { credential, hints };
}

function segmentCountHint(credential: string, analysis: TokenAnalysis): CredentialInputHint | null {
  if (analysis.format !== 'opaque' || !credential.startsWith('eyJ')) return null;
  const segments = credential.split('.').length;
  return segments === 3 || segments === 5 ? null : { kind: 'jwt-like-segment-count', segments };
}

function rawJson(analysis: TokenAnalysis): { header: string; payload: string } | null {
  if (analysis.format !== 'jwt') return null;
  const [header, payload] = analysis.decoded.segments;
  return { header: base64UrlToUtf8(header), payload: base64UrlToUtf8(payload) };
}

/**
 * Classifies pasted input with the same decoder the capture session uses. Time-independent: the
 * temporal status and diagnostics are evaluated by the caller against a live clock.
 */
export function inspectCredentialInput(input: string): CredentialInspection {
  if (input.trim().length === 0) return EMPTY_INSPECTION;
  const normalized = normalizeCredentialInput(input);
  if (!normalized) return { state: 'scheme-only' };
  const { credential, hints } = normalized;
  if (credential.length > MAX_TOKEN_LENGTH) {
    return { state: 'too-large', credential, hints, length: credential.length, limit: MAX_TOKEN_LENGTH };
  }
  const analysis = analyzeBearerToken(credential);
  const segmentHint = segmentCountHint(credential, analysis);
  return {
    state: 'analyzed',
    credential,
    hints: segmentHint ? [...hints, segmentHint] : hints,
    analysis,
    classification: classifyToken(analysis),
    json: rawJson(analysis),
  };
}

/** The token-only fields diagnostics and status need, taken from an analysis without creating a capture record. */
export function toDiagnosticSubject(analysis: TokenAnalysis): DiagnosticSubject {
  return { format: analysis.format, decoded: analysis.decoded, formatDetail: analysis.detail };
}
