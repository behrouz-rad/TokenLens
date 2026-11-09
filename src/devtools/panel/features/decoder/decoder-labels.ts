import type { CredentialInputHint, CredentialInspection } from '@/core/jwt/credential-input';
import type { DiagnosticSeverity } from '@/types';

export interface InspectionSummary {
  /** Short state for the status bar. */
  state: string;
  /** Inline feedback for results without a decoded header and payload; null for a decoded JWT. */
  feedback: { severity: DiagnosticSeverity; title: string; description: string } | null;
}

function kib(length: number): string {
  return `${(length / 1024).toFixed(1)} KiB`;
}

/**
 * Wording for every decoder outcome. Decoding success is never phrased as validity or trust: a
 * decoded JWT is "decoded", and its signature is always described as not verified.
 */
export function summarizeInspection(inspection: CredentialInspection): InspectionSummary {
  switch (inspection.state) {
    case 'empty':
      return { state: 'Waiting for input', feedback: null };
    case 'scheme-only':
      return {
        state: 'No credential after Bearer',
        feedback: { severity: 'warning', title: 'No credential found', description: 'Only the Bearer scheme was entered. Paste the token that follows it.' },
      };
    case 'too-large':
      return {
        state: 'Token too large, not decoded',
        feedback: {
          severity: 'error',
          title: 'Token too large',
          description: `The token is ${kib(inspection.length)}; TokenLens decodes tokens up to ${kib(inspection.limit)}. It was not decoded and nothing was truncated.`,
        },
      };
    case 'analyzed': {
      const { analysis } = inspection;
      switch (analysis.format) {
        case 'jwt':
          return { state: 'JWT decoded · signature not verified', feedback: null };
        case 'malformed-jwt':
          return { state: 'Malformed JWT', feedback: { severity: 'error', title: 'Malformed JWT', description: analysis.detail } };
        case 'opaque':
          return {
            state: 'Opaque token, nothing to decode',
            feedback: {
              severity: 'info',
              title: 'Opaque token',
              description: 'Not a JWT: there is no header or payload to decode. Only the issuing server can interpret this value.',
            },
          };
        case 'unsupported':
          return {
            state: 'Encrypted token, not decrypted',
            feedback: { severity: 'warning', title: 'Unsupported token', description: `${analysis.detail}. TokenLens does not decrypt tokens.` },
          };
      }
    }
  }
}

export function describeHint(hint: CredentialInputHint): string {
  switch (hint.kind) {
    case 'bearer-prefix-removed':
      return 'The Bearer prefix was ignored.';
    case 'surrounding-whitespace-ignored':
      return 'Leading and trailing whitespace was ignored.';
    case 'internal-whitespace':
      return 'The token contains spaces or line breaks. They were not removed; delete them if they came from copying or wrapping.';
    case 'jwt-like-segment-count':
      return `This starts like a JWT header but has ${hint.segments} dot-separated segment${hint.segments === 1 ? '' : 's'}. A signed JWT has 3 and an encrypted JWT has 5, so it may be truncated.`;
  }
}
