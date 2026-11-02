import { useMemo } from 'react';
import { useCaptureStore } from '@/state/capture-store';
import type { NetworkRequest, QuickFilterType, Token, TokenFilter, TokenStatus } from '@/types';

export interface TokenListView {
  /** Tokens that match search, status and quick filters, before the expired-visibility rule. */
  matching: Token[];
  /** Tokens actually shown in the sidebar. */
  visible: Token[];
  /** Matching tokens hidden only because expired tokens are collapsed. */
  hiddenExpiredCount: number;
  /** True when expired tokens are shown because a filter explicitly asks for them. */
  expiredForcedVisible: boolean;
  isFiltered: boolean;
  quickFilterCounts: Record<QuickFilterType, number>;
  statusCounts: Record<TokenStatus, number>;
}

function tokenHasFailedRequest(token: Token, requests: Map<string, NetworkRequest>): boolean {
  return token.requestIds.some((id) => {
    const request = requests.get(id);
    return request !== undefined && request.status >= 400;
  });
}

export function matchesQuickFilter(token: Token, quickFilter: QuickFilterType, requests: Map<string, NetworkRequest>): boolean {
  switch (quickFilter) {
    case 'only-expired':
      return token.status === 'expired';
    case 'expiring-soon':
      return token.status === 'expiring';
    case 'failed-requests':
      return tokenHasFailedRequest(token, requests);
    case 'invalid-tokens':
      return token.status === 'malformed' || token.format === 'unsupported';
  }
}

export function matchesSearch(token: Token, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const subject = typeof token.decoded?.payload.sub === 'string' ? token.decoded.payload.sub : '';
  const issuer = typeof token.decoded?.payload.iss === 'string' ? token.decoded.payload.iss : '';
  return [token.name, token.domain, token.type, subject, issuer, `#${token.sequenceNumber}`].some((field) =>
    field.toLowerCase().includes(q)
  );
}

export function filterTokens(tokens: Iterable<Token>, filter: TokenFilter, requests: Map<string, NetworkRequest>): Token[] {
  const result: Token[] = [];
  for (const token of tokens) {
    if (!matchesSearch(token, filter.search)) continue;
    if (filter.statusFilter && token.status !== filter.statusFilter) continue;
    if (filter.quickFilter && !matchesQuickFilter(token, filter.quickFilter, requests)) continue;
    result.push(token);
  }
  return result.sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.sequenceNumber - a.sequenceNumber);
}

export function isFilterActive(filter: TokenFilter): boolean {
  return filter.search.trim().length > 0 || filter.statusFilter !== null || filter.quickFilter !== null;
}

export function filterRequestsExpired(filter: TokenFilter): boolean {
  return filter.statusFilter === 'expired' || filter.quickFilter === 'only-expired';
}

export function useTokenListView(): TokenListView {
  const tokens = useCaptureStore((s) => s.session.tokens);
  const requests = useCaptureStore((s) => s.session.requests);
  const filter = useCaptureStore((s) => s.filter);
  const showExpired = useCaptureStore((s) => s.showExpired);

  return useMemo(() => {
    const matching = filterTokens(tokens.values(), filter, requests);
    const expiredForcedVisible = filterRequestsExpired(filter);
    const revealExpired = showExpired || expiredForcedVisible;
    const visible = revealExpired ? matching : matching.filter((t) => t.status !== 'expired');

    const quickFilterCounts: Record<QuickFilterType, number> = {
      'only-expired': 0,
      'expiring-soon': 0,
      'failed-requests': 0,
      'invalid-tokens': 0,
    };
    const statusCounts: Record<TokenStatus, number> = {
      active: 0,
      expiring: 0,
      expired: 0,
      'not-yet-valid': 0,
      'no-expiry': 0,
      malformed: 0,
    };
    for (const token of tokens.values()) {
      statusCounts[token.status] += 1;
      for (const id of Object.keys(quickFilterCounts) as QuickFilterType[]) {
        if (matchesQuickFilter(token, id, requests)) quickFilterCounts[id] += 1;
      }
    }

    return {
      matching,
      visible,
      hiddenExpiredCount: matching.length - visible.length,
      expiredForcedVisible,
      isFiltered: isFilterActive(filter),
      quickFilterCounts,
      statusCounts,
    };
  }, [tokens, requests, filter, showExpired]);
}
