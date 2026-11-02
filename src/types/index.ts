export type TokenStatus =
  | 'active'
  | 'expiring'
  | 'expired'
  | 'not-yet-valid'
  | 'no-expiry'
  | 'malformed';

export type TokenFormat = 'jwt' | 'malformed-jwt' | 'opaque' | 'unsupported';

export type TokenType =
  | 'JWT (Access)'
  | 'JWT (ID)'
  | 'JWT'
  | 'Bearer (opaque)'
  | 'Malformed JWT'
  | 'Unsupported';

/** Upper-cased HTTP method as reported by the HAR entry; any method name is accepted. */
export type HttpMethod = string;

export type TokenSource = 'authorization-header';

export type DiagnosticSeverity = 'success' | 'warning' | 'error' | 'info';

export type SignatureState = 'not-verified' | 'unsigned' | 'unsupported';

export type TimelineEventType = 'issued' | 'captured' | 'used-in-request' | 'failed-request' | 'expired';

export type JwtHeader = Record<string, unknown> & {
  alg?: string;
  typ?: string;
  kid?: string;
};

export type JwtPayload = Record<string, unknown>;

export interface ClaimIssue {
  claim: string;
  message: string;
}

export interface DecodedToken {
  header: JwtHeader;
  payload: JwtPayload;
  segments: [header: string, payload: string, signature: string];
  signaturePresent: boolean;
  issues: ClaimIssue[];
}

export interface Token {
  id: string;
  sequenceNumber: number;
  fingerprint: string;
  name: string;
  type: TokenType;
  format: TokenFormat;
  typeBasis: string;
  source: TokenSource;
  domain: string;
  capturedAt: number;
  lastSeenAt: number;
  status: TokenStatus;
  expiresAt: number | null;
  notBeforeAt: number | null;
  decoded: DecodedToken | null;
  formatDetail: string | null;
  raw: string;
  requestIds: string[];
}

export interface NetworkRequest {
  id: string;
  url: string;
  method: HttpMethod;
  status: number;
  statusText: string;
  durationMs: number;
  startedAt: number;
  tokenId: string;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  description: string;
  severity: DiagnosticSeverity;
  details?: string;
}

export interface TimelineEvent {
  id: string;
  tokenId: string;
  type: TimelineEventType;
  timestamp: number;
  label: string;
  requestId?: string;
  status?: number;
}

export type QuickFilterType = 'only-expired' | 'expiring-soon' | 'failed-requests' | 'invalid-tokens';

export interface TokenFilter {
  search: string;
  statusFilter: TokenStatus | null;
  quickFilter: QuickFilterType | null;
}

export type MainTab = 'overview' | 'requests' | 'timeline';

/** HTTP status class used by the Requests explorer; responses outside 200–599 (e.g. status 0) fall in none of them. */
export type RequestStatusCategory = '2xx' | '3xx' | '4xx' | '5xx';

export interface RequestFilter {
  search: string;
  statusCategory: RequestStatusCategory | null;
  tokenId: string | null;
}

export interface TimelineFilter {
  tokenId: string | null;
  eventType: TimelineEventType | null;
}

export type DetailTab = 'overview' | 'payload' | 'header' | 'claims' | 'scopes' | 'raw';

export interface CaptureLimits {
  maxTokens: number;
  maxRequests: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxTokens: 500,
  maxRequests: 5000,
};

export const DEFAULT_EXPIRING_THRESHOLD_MS = 5 * 60 * 1000;
