import { analyzeBearerToken, classifyToken, computeTokenStatus, getTemporalBounds, inferTokenName } from '@/core/jwt/decoder';
import { fingerprintToken } from '@/core/jwt/fingerprint';
import { DEFAULT_EXPIRING_THRESHOLD_MS, type Token } from '@/types';

let sequence = 0;

/** Builds a Token record the same way the capture session does, for tests that bypass ingestion. */
export function buildToken(raw: string, now: number, overrides: Partial<Token> = {}): Token {
  const analysis = analyzeBearerToken(raw);
  const classification = classifyToken(analysis);
  const bounds = getTemporalBounds(analysis.decoded);
  sequence += 1;
  return {
    id: `tok-${sequence}`,
    sequenceNumber: sequence,
    fingerprint: fingerprintToken(raw),
    name: inferTokenName(classification.type),
    type: classification.type,
    format: analysis.format,
    typeBasis: classification.basis,
    source: 'authorization-header',
    domain: 'api.example.test',
    capturedAt: now,
    lastSeenAt: now,
    status: computeTokenStatus(analysis.format, analysis.decoded, now, DEFAULT_EXPIRING_THRESHOLD_MS),
    expiresAt: bounds.expiresAt,
    notBeforeAt: bounds.notBeforeAt,
    decoded: analysis.decoded,
    formatDetail: analysis.detail,
    raw,
    requestIds: [],
    ...overrides,
  };
}
