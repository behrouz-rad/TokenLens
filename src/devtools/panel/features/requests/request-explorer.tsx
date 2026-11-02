import { useCaptureStore } from '@/state/capture-store';
import { STATUS_CATEGORIES, useRequestExplorer } from '@/hooks/use-request-explorer';
import { RequestGrid } from './request-grid';
import { EmptyState } from '../../components/ui/empty-state';
import { FilterChip } from '../../components/ui/filter-chip';
import { Network, Search, SearchX } from 'lucide-react';

const fieldClass =
  'rounded border border-transparent bg-dt-bg-tertiary px-2 py-1 text-xs text-dt-text placeholder:text-dt-text-tertiary focus:border-dt-accent focus:outline-none';

/** Every captured Bearer-authenticated request across all tokens, with search, filters and sorting. */
export function RequestExplorer() {
  const filter = useCaptureStore((s) => s.requestFilter);
  const setFilter = useCaptureStore((s) => s.setRequestFilter);
  const clearFilter = useCaptureStore((s) => s.clearRequestFilter);
  const { rows, total, categoryCounts, isFiltered, tokenFilterMissing, tokenOptions, focusedRequestId } = useRequestExplorer();

  return (
    <div className="flex h-full flex-col" data-testid="requests-explorer">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-dt-border bg-dt-bg-secondary px-3 py-2">
        <h2 className="text-xs font-semibold text-dt-text" data-testid="requests-heading">
          Requests <span className="font-normal text-dt-text-tertiary">({isFiltered ? `${rows.length} of ${total}` : total})</span>
        </h2>
        <label className="relative min-w-[180px] flex-1 basis-48">
          <span className="sr-only">Search requests</span>
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dt-text-tertiary" aria-hidden />
          <input
            type="search"
            value={filter.search}
            onChange={(e) => setFilter({ search: e.target.value })}
            placeholder="URL, host, method, status or token…"
            className={`${fieldClass} w-full pl-7`}
          />
        </label>
        <div role="group" aria-label="Filter by HTTP status" className="flex items-center gap-1">
          <FilterChip label="All" count={total} active={filter.statusCategory === null} onClick={() => setFilter({ statusCategory: null })} />
          {STATUS_CATEGORIES.map((category) => (
            <FilterChip
              key={category}
              label={category}
              count={categoryCounts[category]}
              active={filter.statusCategory === category}
              onClick={() => setFilter({ statusCategory: filter.statusCategory === category ? null : category })}
            />
          ))}
        </div>
        <label className="flex items-center gap-1 text-2xs text-dt-text-tertiary">
          <span className="sr-only">Filter by token</span>
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
        </label>
        {isFiltered && (
          <button onClick={clearFilter} className="text-2xs text-dt-accent hover:underline">
            Clear filters
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {total === 0 ? (
          <EmptyState
            icon={Network}
            title="No requests captured yet"
            description="Requests that send an Authorization: Bearer header appear here as soon as the inspected page makes them."
            className="h-full"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title={tokenFilterMissing ? 'The filtered token is no longer in the session' : 'No requests match the current filters'}
            description={tokenFilterMissing ? 'It was evicted by the capture limits or cleared. Clear the filter to see all requests.' : undefined}
            className="h-full"
          >
            <button onClick={clearFilter} className="mt-2 rounded bg-dt-bg-elevated px-2 py-1 text-2xs text-dt-accent hover:bg-dt-bg-hover">
              Show all requests
            </button>
          </EmptyState>
        ) : (
          <RequestGrid rows={rows} showHost showToken focusedId={focusedRequestId} className="h-full" ariaLabel="Captured requests (scrollable)" />
        )}
      </div>
    </div>
  );
}
