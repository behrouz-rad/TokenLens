import { useMemo } from 'react';
import { useCaptureStore } from '@/state/capture-store';
import type { NetworkRequest, RequestFilter, RequestStatusCategory, Token } from '@/types';

/** A captured request joined with its canonical token. `token` is null only if integrity were ever broken. */
export interface RequestRow {
  request: NetworkRequest;
  token: Token | null;
  host: string;
}

export interface RequestExplorerView {
  rows: RequestRow[];
  total: number;
  categoryCounts: Record<RequestStatusCategory, number>;
  isFiltered: boolean;
  /** True when the token filter points at a token that has since been evicted or cleared. */
  tokenFilterMissing: boolean;
  /** Tokens offered by the token filter, most recently seen first. */
  tokenOptions: Token[];
  /** The focused request if it is still captured; null otherwise. */
  focusedRequestId: string | null;
}

export const STATUS_CATEGORIES: RequestStatusCategory[] = ['2xx', '3xx', '4xx', '5xx'];

export function statusCategory(status: number): RequestStatusCategory | null {
  if (status >= 600) return null;
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return null;
}

const HOST_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i;

/** Cheap host extraction; avoids constructing a URL object for every request on every render. */
export function requestHost(url: string): string {
  const match = HOST_PATTERN.exec(url);
  return match?.[1]?.toLowerCase() ?? '';
}

export function matchesRequestSearch(row: RequestRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { request, token } = row;
  if (request.url.toLowerCase().includes(q)) return true;
  if (request.method.toLowerCase() === q) return true;
  if (String(request.status) === q) return true;
  if (!token) return false;
  return token.name.toLowerCase().includes(q) || `#${token.sequenceNumber}` === q;
}

export function isRequestFilterActive(filter: RequestFilter): boolean {
  return filter.search.trim().length > 0 || filter.statusCategory !== null || filter.tokenId !== null;
}

/** Joins every captured request with its token and applies the explorer filter; newest first. */
export function filterRequests(requests: Iterable<NetworkRequest>, tokens: Map<string, Token>, filter: RequestFilter): RequestRow[] {
  const rows: RequestRow[] = [];
  for (const request of requests) {
    if (filter.tokenId !== null && request.tokenId !== filter.tokenId) continue;
    if (filter.statusCategory !== null && statusCategory(request.status) !== filter.statusCategory) continue;
    const row: RequestRow = { request, token: tokens.get(request.tokenId) ?? null, host: requestHost(request.url) };
    if (!matchesRequestSearch(row, filter.search)) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => b.request.startedAt - a.request.startedAt || b.request.id.localeCompare(a.request.id, undefined, { numeric: true }));
}

export function useRequestExplorer(): RequestExplorerView {
  const requests = useCaptureStore((s) => s.session.requests);
  const tokens = useCaptureStore((s) => s.session.tokens);
  const filter = useCaptureStore((s) => s.requestFilter);
  const focused = useCaptureStore((s) => s.focusedRequestId);

  return useMemo(() => {
    const categoryCounts: Record<RequestStatusCategory, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    for (const request of requests.values()) {
      const category = statusCategory(request.status);
      if (category) categoryCounts[category] += 1;
    }
    const tokenOptions = [...tokens.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.sequenceNumber - a.sequenceNumber);
    return {
      rows: filterRequests(requests.values(), tokens, filter),
      total: requests.size,
      categoryCounts,
      isFiltered: isRequestFilterActive(filter),
      tokenFilterMissing: filter.tokenId !== null && !tokens.has(filter.tokenId),
      tokenOptions,
      focusedRequestId: focused !== null && requests.has(focused) ? focused : null,
    };
  }, [requests, tokens, filter, focused]);
}
