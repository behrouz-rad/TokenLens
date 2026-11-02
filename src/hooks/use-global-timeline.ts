import { useMemo } from 'react';
import { useCaptureStore } from '@/state/capture-store';
import type { TimelineEvent, TimelineEventType, TimelineFilter, Token } from '@/types';

/**
 * Observed events come from traffic TokenLens actually saw. Claim-derived events are placed on
 * the timeline from the token's own `iat`/`exp` values, which TokenLens cannot verify; the UI
 * labels them as such and never presents them as evidence that a token was issued or refreshed.
 */
export type TimelineEventBasis = 'observed' | 'claim';

export const EVENT_BASIS: Record<TimelineEventType, TimelineEventBasis> = {
  captured: 'observed',
  'used-in-request': 'observed',
  'failed-request': 'observed',
  issued: 'claim',
  expired: 'claim',
};

export const EVENT_TYPE_ORDER: TimelineEventType[] = ['captured', 'used-in-request', 'failed-request', 'expired', 'issued'];

export interface TimelineRow {
  event: TimelineEvent;
  token: Token | null;
  basis: TimelineEventBasis;
}

export interface GlobalTimelineView {
  rows: TimelineRow[];
  total: number;
  typeCounts: Record<TimelineEventType, number>;
  isFiltered: boolean;
  tokenFilterMissing: boolean;
  tokenOptions: Token[];
}

export function isTimelineFilterActive(filter: TimelineFilter): boolean {
  return filter.tokenId !== null || filter.eventType !== null;
}

/**
 * Flattens per-token event lists into one chronological stream, newest first. Events that share
 * a timestamp (a token's first observation and the request that carried it) keep their recording
 * order, so the later-recorded event is listed first.
 */
export function collectTimeline(eventsByToken: Map<string, TimelineEvent[]>, tokens: Map<string, Token>, filter: TimelineFilter): TimelineRow[] {
  const rows: { row: TimelineRow; order: number }[] = [];
  let order = 0;
  const addToken = (tokenId: string, events: TimelineEvent[]) => {
    const token = tokens.get(tokenId) ?? null;
    for (const event of events) {
      order += 1;
      if (filter.eventType !== null && event.type !== filter.eventType) continue;
      rows.push({ row: { event, token, basis: EVENT_BASIS[event.type] }, order });
    }
  };
  if (filter.tokenId !== null) {
    const events = eventsByToken.get(filter.tokenId);
    if (events) addToken(filter.tokenId, events);
  } else {
    for (const [tokenId, events] of eventsByToken) addToken(tokenId, events);
  }
  return rows.sort((a, b) => b.row.event.timestamp - a.row.event.timestamp || b.order - a.order).map((r) => r.row);
}

export function useGlobalTimeline(): GlobalTimelineView {
  const eventsByToken = useCaptureStore((s) => s.session.eventsByToken);
  const tokens = useCaptureStore((s) => s.session.tokens);
  const filter = useCaptureStore((s) => s.timelineFilter);

  return useMemo(() => {
    const typeCounts: Record<TimelineEventType, number> = { captured: 0, 'used-in-request': 0, 'failed-request': 0, expired: 0, issued: 0 };
    let total = 0;
    for (const events of eventsByToken.values()) {
      total += events.length;
      for (const event of events) typeCounts[event.type] += 1;
    }
    return {
      rows: collectTimeline(eventsByToken, tokens, filter),
      total,
      typeCounts,
      isFiltered: isTimelineFilterActive(filter),
      tokenFilterMissing: filter.tokenId !== null && !tokens.has(filter.tokenId),
      tokenOptions: [...tokens.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.sequenceNumber - a.sequenceNumber),
    };
  }, [eventsByToken, tokens, filter]);
}
