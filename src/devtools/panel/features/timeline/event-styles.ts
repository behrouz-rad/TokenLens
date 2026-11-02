import type { TimelineEventType } from '@/types';

/**
 * Names say where an event comes from: "observed" events were seen in traffic, while the
 * iat/exp based ones are only what the token claims about itself.
 */
export const EVENT_STYLES: Record<TimelineEventType, { color: string; dotColor: string; name: string }> = {
  captured: { color: 'text-dt-accent', dotColor: 'bg-dt-accent', name: 'First observed' },
  'used-in-request': { color: 'text-dt-success', dotColor: 'bg-dt-success', name: 'Used in request' },
  'failed-request': { color: 'text-dt-error', dotColor: 'bg-dt-error', name: 'Failed request' },
  expired: { color: 'text-dt-error', dotColor: 'bg-dt-error', name: 'Expired (exp claim)' },
  issued: { color: 'text-dt-info', dotColor: 'bg-dt-info', name: 'Issued (iat claim)' },
};
