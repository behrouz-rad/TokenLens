import { utf8ToBase64Url } from '@/core/jwt/base64url';
import type { CaptureObservation, RequestObservation } from '@/core/capture/observation';

/**
 * Synthetic credentials for development seeding and tests. The signature segment is random
 * filler; these tokens were never issued by anyone and cannot authenticate against anything.
 */
export const SYNTHETIC_SIGNATURE = 'c3ludGhldGljLXNpZ25hdHVyZS1ub3QtcmVhbA';

export function createSyntheticJwt(header: Record<string, unknown>, payload: Record<string, unknown>, signature: string = SYNTHETIC_SIGNATURE): string {
  return `${utf8ToBase64Url(JSON.stringify(header))}.${utf8ToBase64Url(JSON.stringify(payload))}.${signature}`;
}

let sequence = 0;

export function resetSyntheticSequence(): void {
  sequence = 0;
}

export function createRequestObservation(overrides: Partial<RequestObservation> = {}): RequestObservation {
  sequence += 1;
  return {
    kind: 'request',
    relayId: 'test-relay',
    seq: sequence,
    url: 'https://api.example.test/resource',
    method: 'GET',
    status: 200,
    statusText: 'OK',
    startedAt: 1_700_000_000_000 + sequence * 1000,
    durationMs: 42,
    bearerToken: null,
    authorizationScheme: null,
    ...overrides,
  };
}

export function withBearer(token: string, overrides: Partial<RequestObservation> = {}): RequestObservation {
  return createRequestObservation({ bearerToken: token, authorizationScheme: 'bearer', ...overrides });
}

export function createNavigationObservation(url: string, at: number, relayId = 'test-relay'): CaptureObservation {
  sequence += 1;
  return { kind: 'navigation', relayId, seq: sequence, url, at };
}
