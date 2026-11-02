import { useCaptureStore } from '@/state/capture-store';
import { useTokenListView } from '@/hooks/use-filtered-tokens';
import { QUICK_FILTERS, STATUS_LABELS } from '@/lib/token-status';
import { cn } from '@/lib/cn';
import { FilterChip } from '../ui/filter-chip';
import type { TokenStatus } from '@/types';

const STATUS_ORDER: TokenStatus[] = ['active', 'expiring', 'expired', 'not-yet-valid', 'no-expiry', 'malformed'];

export function FiltersPopoverContent({ matchingCount }: { matchingCount: number }) {
  const filter = useCaptureStore((s) => s.filter);
  const setSearch = useCaptureStore((s) => s.setSearch);
  const setStatusFilter = useCaptureStore((s) => s.setStatusFilter);
  const setQuickFilter = useCaptureStore((s) => s.setQuickFilter);
  const clearFilters = useCaptureStore((s) => s.clearFilters);
  const showExpired = useCaptureStore((s) => s.showExpired);
  const setShowExpired = useCaptureStore((s) => s.setShowExpired);
  const totalTokens = useCaptureStore((s) => s.session.tokens.size);
  const { quickFilterCounts, statusCounts, isFiltered, expiredForcedVisible } = useTokenListView();

  return (
    <div className="flex flex-col gap-3" data-testid="filters-popover">
      <label className="flex flex-col gap-1">
        <span className="text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary">Search</span>
        <input
          type="search"
          value={filter.search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, domain, type, subject, issuer, #seq"
          className="w-full rounded border border-transparent bg-dt-bg-tertiary px-2 py-1 text-xs text-dt-text placeholder:text-dt-text-tertiary focus:border-dt-accent focus:outline-none"
        />
      </label>

      <fieldset>
        <legend className="mb-1 text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary">Status</legend>
        <div className="grid grid-cols-2 gap-1">
          <FilterChip label="Any" count={totalTokens} active={filter.statusFilter === null} onClick={() => setStatusFilter(null)} />
          {STATUS_ORDER.map((status) => (
            <FilterChip
              key={status}
              label={STATUS_LABELS[status]}
              count={statusCounts[status]}
              active={filter.statusFilter === status}
              onClick={() => setStatusFilter(filter.statusFilter === status ? null : status)}
            />
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary">Quick filters</legend>
        <div className="flex flex-col gap-1">
          {QUICK_FILTERS.map((q) => (
            <FilterChip
              key={q.id}
              label={q.label}
              count={quickFilterCounts[q.id]}
              active={filter.quickFilter === q.id}
              onClick={() => setQuickFilter(filter.quickFilter === q.id ? null : q.id)}
            />
          ))}
        </div>
      </fieldset>

      <label className={cn('flex items-center gap-2 text-xs', expiredForcedVisible && 'opacity-60')}>
        <input
          type="checkbox"
          checked={showExpired || expiredForcedVisible}
          disabled={expiredForcedVisible}
          onChange={(e) => setShowExpired(e.target.checked)}
          className="accent-(--dt-accent)"
        />
        <span>Show expired tokens in list</span>
      </label>
      {expiredForcedVisible && <p className="-mt-2 text-2xs text-dt-text-tertiary">Expired tokens are shown because the active filter asks for them.</p>}

      <div className="flex items-center justify-between border-t border-dt-border pt-2">
        <span className="text-2xs text-dt-text-tertiary">
          {isFiltered ? `Showing ${matchingCount} of ${totalTokens} tokens` : 'Showing all tokens'}
        </span>
        <button
          onClick={clearFilters}
          disabled={!isFiltered}
          className="rounded px-2 py-0.5 text-2xs text-dt-accent hover:bg-dt-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear filters
        </button>
      </div>
    </div>
  );
}

