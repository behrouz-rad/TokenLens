import { useMemo } from 'react';
import { useCaptureStore } from '@/state/capture-store';
import type { NetworkRequest, TimelineEvent, Token } from '@/types';

export function useSelectedToken(): Token | null {
  const selectedId = useCaptureStore((s) => s.session.selectedTokenId);
  const tokens = useCaptureStore((s) => s.session.tokens);
  if (!selectedId) return null;
  return tokens.get(selectedId) ?? null;
}

export function useTokenRequests(token: Token | null): NetworkRequest[] {
  const requests = useCaptureStore((s) => s.session.requests);
  return useMemo(() => {
    if (!token) return [];
    const result: NetworkRequest[] = [];
    for (const id of token.requestIds) {
      const request = requests.get(id);
      if (request) result.push(request);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }, [token, requests]);
}

export function useTokenEvents(token: Token | null): TimelineEvent[] {
  const eventsByToken = useCaptureStore((s) => s.session.eventsByToken);
  return useMemo(() => {
    if (!token) return [];
    const events = eventsByToken.get(token.id) ?? [];
    return [...events].sort((a, b) => b.timestamp - a.timestamp);
  }, [token, eventsByToken]);
}
