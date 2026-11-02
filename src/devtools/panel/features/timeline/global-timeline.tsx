import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCaptureStore } from '@/state/capture-store';
import { EVENT_TYPE_ORDER, useGlobalTimeline, type TimelineRow } from '@/hooks/use-global-timeline';
import { showRequestInExplorer, showTokenInOverview } from '@/state/capture-actions';
import { formatDateTime, formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/cn';
import { EVENT_STYLES } from './event-styles';
import { EmptyState } from '../../components/ui/empty-state';
import { FilterChip } from '../../components/ui/filter-chip';
import { Clock, SearchX } from 'lucide-react';

const ROW_HEIGHT = 44;

const fieldClass = 'rounded border border-transparent bg-dt-bg-tertiary px-2 py-1 text-xs text-dt-text focus:border-dt-accent focus:outline-none';

/** Chronological view of every token event in the session, newest first. */
export function GlobalTimeline() {
  const filter = useCaptureStore((s) => s.timelineFilter);
  const setFilter = useCaptureStore((s) => s.setTimelineFilter);
  const clearFilter = useCaptureStore((s) => s.clearTimelineFilter);
  const { rows, total, typeCounts, isFiltered, tokenFilterMissing, tokenOptions } = useGlobalTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div className="flex h-full flex-col" data-testid="global-timeline">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-dt-border bg-dt-bg-secondary px-3 py-2">
        <h2 className="text-xs font-semibold text-dt-text" data-testid="timeline-heading">
          Timeline <span className="font-normal text-dt-text-tertiary">({isFiltered ? `${rows.length} of ${total}` : total} events)</span>
        </h2>
        <div role="group" aria-label="Filter by event type" className="flex flex-wrap items-center gap-1">
          <FilterChip label="All" count={total} active={filter.eventType === null} onClick={() => setFilter({ eventType: null })} />
          {EVENT_TYPE_ORDER.map((type) => (
            <FilterChip
              key={type}
              label={EVENT_STYLES[type].name}
              count={typeCounts[type]}
              active={filter.eventType === type}
              onClick={() => setFilter({ eventType: filter.eventType === type ? null : type })}
            />
          ))}
        </div>
        <select
          value={filter.tokenId ?? ''}
          onChange={(e) => setFilter({ tokenId: e.target.value || null })}
          className={`${fieldClass} max-w-[220px]`}
          aria-label="Filter by token"
        >
          <option value="">All tokens</option>
          {tokenFilterMissing && filter.tokenId && (
            <option value={filter.tokenId} disabled>
              (evicted token)
            </option>
          )}
          {tokenOptions.map((token) => (
            <option key={token.id} value={token.id}>
              {token.name} #{token.sequenceNumber} · {token.domain}
            </option>
          ))}
        </select>
        {isFiltered && (
          <button onClick={clearFilter} className="text-2xs text-dt-accent hover:underline">
            Clear filters
          </button>
        )}
        <p className="basis-full text-2xs text-dt-text-tertiary">
          <span className="font-medium">Observed</span> events come from captured traffic. <span className="font-medium">Claim</span> events are placed from the
          token&apos;s own iat/exp values and are not independently verified.
        </p>
      </div>

      <div className="min-h-0 flex-1">
        {total === 0 ? (
          <EmptyState
            icon={Clock}
            title="No events yet"
            description="Token and request events appear here as soon as the inspected page sends an Authorization: Bearer header."
            className="h-full"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title={tokenFilterMissing ? 'The filtered token is no longer in the session' : 'No events match the current filters'}
            description={tokenFilterMissing ? 'It was evicted by the capture limits or cleared. Clear the filter to see all events.' : undefined}
            className="h-full"
          >
            <button onClick={clearFilter} className="mt-2 rounded bg-dt-bg-elevated px-2 py-1 text-2xs text-dt-accent hover:bg-dt-bg-hover">
              Show all events
            </button>
          </EmptyState>
        ) : (
          <div ref={scrollRef} data-virtual-scroll tabIndex={0} aria-label="Timeline events (scrollable)" className="h-full overflow-auto scrollbar-thin">
            <ol className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <li
                    key={row.event.id}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <TimelineEntry row={row} />
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineEntry({ row }: { row: TimelineRow }) {
  const { event, token, basis } = row;
  const style = EVENT_STYLES[event.type];
  return (
    <div
      className="flex items-start gap-3 border-b border-dt-border-subtle px-3 py-1.5 hover:bg-dt-bg-hover"
      data-testid="global-timeline-event"
      data-event-type={event.type}
      data-basis={basis}
      data-token-id={event.tokenId}
    >
      <time className="w-14 shrink-0 pt-0.5 font-mono text-2xs text-dt-text-tertiary" dateTime={new Date(event.timestamp).toISOString()} title={formatDateTime(event.timestamp)}>
        {formatTimestamp(event.timestamp)}
      </time>
      <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', style.dotColor)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-xs', style.color)} title={event.label}>
          {event.label}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-dt-text-tertiary">
          <span>{style.name}</span>
          <span
            className={cn('rounded px-1 font-medium uppercase tracking-wider', basis === 'observed' ? 'bg-dt-bg-elevated text-dt-text-secondary' : 'bg-dt-warning/15 text-dt-warning')}
            title={basis === 'observed' ? 'Seen in captured traffic' : 'Derived from the token claims; not independently verified'}
          >
            {basis === 'observed' ? 'observed' : 'claim'}
          </span>
          {token ? (
            <button
              type="button"
              onClick={() => showTokenInOverview(token.id)}
              aria-label={`Show ${token.name} #${token.sequenceNumber} in Overview`}
              className="rounded px-1 text-dt-accent hover:bg-dt-bg-active hover:underline"
            >
              {token.name} <span className="font-mono">#{token.sequenceNumber}</span>
            </button>
          ) : (
            <span>evicted token</span>
          )}
          {event.requestId && (
            <button
              type="button"
              onClick={() => showRequestInExplorer(event.requestId ?? '')}
              aria-label={`Show request ${event.label} in Requests`}
              className="rounded px-1 text-dt-accent hover:bg-dt-bg-active hover:underline"
            >
              Open request
            </button>
          )}
        </div>
      </div>
      {event.status !== undefined && (
        <span className={cn('shrink-0 pt-0.5 font-mono text-2xs', event.status >= 500 ? 'text-dt-error' : event.status >= 400 ? 'text-dt-warning' : 'text-dt-success')}>
          {event.status}
        </span>
      )}
    </div>
  );
}
