import { useState } from 'react';
import { useSelectedToken, useTokenEvents } from '@/hooks/use-selected-token';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/cn';
import { EVENT_STYLES } from './event-styles';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { TimelineEvent } from '@/types';

const COLLAPSED_LIMIT = 8;

export function TokenTimeline() {
  const token = useSelectedToken();
  const events = useTokenEvents(token);
  const [expanded, setExpanded] = useState(false);

  if (!token) return null;

  const visible = expanded ? events : events.slice(0, COLLAPSED_LIMIT);

  return (
    <section className="rounded-lg border border-dt-border bg-dt-bg-secondary" aria-labelledby="token-timeline-heading" data-testid="token-timeline">
      <div className="flex items-center justify-between border-b border-dt-border px-3 py-2">
        <h3 id="token-timeline-heading" className="text-xs font-semibold text-dt-text">
          Token Timeline
        </h3>
        <span className="text-2xs text-dt-text-tertiary">{events.length} events</span>
      </div>
      <ol tabIndex={0} aria-label="Timeline events (scrollable)" className={cn('overflow-auto scrollbar-thin', expanded ? 'max-h-[60vh]' : 'max-h-[220px]')}>
        {visible.length === 0 && <li className="px-3 py-3 text-2xs text-dt-text-tertiary">No events recorded yet.</li>}
        {visible.map((event, i) => (
          <TimelineRow key={event.id} event={event} isLast={i === visible.length - 1} />
        ))}
      </ol>
      {events.length > COLLAPSED_LIMIT && (
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 border-t border-dt-border px-3 py-1.5 text-2xs text-dt-accent transition-colors hover:text-dt-accent-hover"
        >
          {expanded ? (
            <>
              Show recent only <ChevronUp size={10} aria-hidden />
            </>
          ) : (
            <>
              Show all {events.length} events <ChevronDown size={10} aria-hidden />
            </>
          )}
        </button>
      )}
    </section>
  );
}

function TimelineRow({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
  const style = EVENT_STYLES[event.type];
  return (
    <li className="flex items-start gap-3 px-3 py-1.5" data-testid="timeline-event" data-event-type={event.type}>
      <time className="w-14 shrink-0 pt-0.5 font-mono text-2xs text-dt-text-tertiary" dateTime={new Date(event.timestamp).toISOString()}>
        {formatTimestamp(event.timestamp)}
      </time>
      <div className="relative flex flex-col items-center pt-1">
        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-dt-bg-secondary', style.dotColor)} aria-hidden />
        {!isLast && <span className="min-h-[14px] w-px flex-1 bg-dt-border" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1 pb-1">
        <div className={cn('truncate text-xs', style.color)} title={event.label}>
          {event.label}
        </div>
        <span className="text-2xs text-dt-text-tertiary">{style.name}</span>
      </div>
      {event.status !== undefined && (
        <span
          className={cn(
            'shrink-0 pt-0.5 font-mono text-2xs',
            event.status >= 500 ? 'text-dt-error' : event.status >= 400 ? 'text-dt-warning' : 'text-dt-success'
          )}
        >
          {event.status}
        </span>
      )}
    </li>
  );
}
