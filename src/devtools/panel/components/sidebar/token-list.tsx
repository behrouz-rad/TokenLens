import { useRef, useCallback, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCaptureStore } from '@/state/capture-store';
import { useTokenListView } from '@/hooks/use-filtered-tokens';
import { useNow } from '@/state/clock';
import { cn } from '@/lib/cn';
import { formatExpiryCompact } from '@/lib/format';
import { StatusBadge } from '../ui/status-badge';
import { QUICK_FILTERS, STATUS_DOT_CLASS } from '@/lib/token-status';
import type { Token } from '@/types';
import { Search, Eye, EyeOff, Shield, SearchX } from 'lucide-react';

interface TokenListProps {
  onTokenActivated?: (token: Token) => void;
}

export function TokenList({ onTokenActivated }: TokenListProps) {
  const selectedTokenId = useCaptureStore((s) => s.session.selectedTokenId);
  const select = useCaptureStore((s) => s.select);
  const search = useCaptureStore((s) => s.filter.search);
  const setSearch = useCaptureStore((s) => s.setSearch);
  const quickFilter = useCaptureStore((s) => s.filter.quickFilter);
  const setQuickFilter = useCaptureStore((s) => s.setQuickFilter);
  const clearFilters = useCaptureStore((s) => s.clearFilters);
  const showExpired = useCaptureStore((s) => s.showExpired);
  const setShowExpired = useCaptureStore((s) => s.setShowExpired);
  const totalTokens = useCaptureStore((s) => s.session.tokens.size);
  const { visible, matching, hiddenExpiredCount, expiredForcedVisible, isFiltered, quickFilterCounts } = useTokenListView();
  const parentRef = useRef<HTMLDivElement>(null);
  const now = useNow(1000);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 68,
    overscan: 6,
  });

  const activate = useCallback(
    (token: Token) => {
      select(token.id);
      onTokenActivated?.(token);
    },
    [select, onTokenActivated]
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (visible.length === 0) return;
    event.preventDefault();
    const currentIndex = visible.findIndex((t) => t.id === selectedTokenId);
    const nextIndex =
      event.key === 'ArrowDown' ? Math.min(visible.length - 1, currentIndex + 1) : Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1);
    const next = visible[nextIndex];
    if (next) {
      select(next.id);
      virtualizer.scrollToIndex(nextIndex);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="token-list">
      <div className="border-b border-dt-border p-2">
        <div className="flex items-center justify-between gap-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-dt-text-secondary" data-testid="token-list-heading">
            Tokens ({isFiltered ? `${matching.length}/${totalTokens}` : totalTokens})
          </h2>
          {isFiltered && (
            <button onClick={clearFilters} className="text-2xs text-dt-accent hover:underline">
              Clear filters
            </button>
          )}
        </div>
        <div className="relative mt-2">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dt-text-tertiary" aria-hidden />
          <input
            type="search"
            aria-label="Filter tokens"
            placeholder="Filter tokens…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cn(
              'w-full rounded border border-transparent bg-dt-bg-tertiary py-1.5 pl-7 pr-2 text-xs text-dt-text',
              'placeholder:text-dt-text-tertiary focus:border-dt-accent focus:outline-none'
            )}
          />
        </div>
      </div>

      <div ref={parentRef} data-virtual-scroll className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {visible.length === 0 && totalTokens === 0 && (
          <EmptyHint
            icon={Shield}
            title="No tokens captured yet"
            description="Trigger requests on the inspected page that send an Authorization: Bearer header. Only traffic recorded after DevTools opened can be seen."
          />
        )}
        {visible.length === 0 && totalTokens > 0 && hiddenExpiredCount === 0 && (
          <EmptyHint icon={SearchX} title="No tokens match the current filters" action={{ label: 'Clear filters', onClick: clearFilters }} />
        )}
        {visible.length === 0 && hiddenExpiredCount > 0 && (
          <EmptyHint
            icon={EyeOff}
            title={`${hiddenExpiredCount} expired token${hiddenExpiredCount === 1 ? '' : 's'} hidden`}
            action={{ label: 'Show expired', onClick: () => setShowExpired(true) }}
          />
        )}

        <div
          role="listbox"
          aria-label="Captured tokens"
          aria-activedescendant={selectedTokenId ? `token-option-${selectedTokenId}` : undefined}
          tabIndex={visible.length > 0 ? 0 : -1}
          onKeyDown={handleKeyDown}
          className="relative focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-dt-accent"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const token = visible[item.index];
            if (!token) return null;
            return (
              <div
                key={token.id}
                role="presentation"
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <TokenItem token={token} now={now} isSelected={token.id === selectedTokenId} onSelect={() => activate(token)} />
              </div>
            );
          })}
        </div>

        {hiddenExpiredCount > 0 && visible.length > 0 && (
          <button
            onClick={() => setShowExpired(true)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-dt-text-tertiary transition-colors hover:text-dt-text"
          >
            <Eye size={12} aria-hidden />
            Show expired ({hiddenExpiredCount})
          </button>
        )}
        {showExpired && !expiredForcedVisible && visible.some((t) => t.status === 'expired') && (
          <button
            onClick={() => setShowExpired(false)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-dt-text-tertiary transition-colors hover:text-dt-text"
          >
            <EyeOff size={12} aria-hidden />
            Hide expired
          </button>
        )}
      </div>

      <div className="border-t border-dt-border p-2">
        <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary">Quick Filters</p>
        <div className="flex flex-col gap-1">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setQuickFilter(quickFilter === f.id ? null : f.id)}
              aria-pressed={quickFilter === f.id}
              className={cn(
                'flex items-center justify-between rounded px-2 py-1 text-xs transition-colors',
                quickFilter === f.id ? 'bg-dt-accent/15 text-dt-accent-strong' : 'text-dt-text-secondary hover:bg-dt-bg-hover hover:text-dt-text'
              )}
            >
              <span>{f.label}</span>
              <span className="text-2xs text-dt-text-tertiary" data-testid={`quick-filter-count-${f.id}`}>
                {quickFilterCounts[f.id]}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyHint({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Shield;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center" data-testid="token-list-empty">
      <Icon size={20} className="text-dt-text-tertiary" aria-hidden />
      <p className="text-xs font-medium text-dt-text-secondary">{title}</p>
      {description && <p className="text-2xs text-dt-text-tertiary">{description}</p>}
      {action && (
        <button onClick={action.onClick} className="mt-1 rounded bg-dt-bg-elevated px-2 py-1 text-2xs text-dt-accent hover:bg-dt-bg-hover">
          {action.label}
        </button>
      )}
    </div>
  );
}

function TokenItem({ token, now, isSelected, onSelect }: { token: Token; now: number; isSelected: boolean; onSelect: () => void }) {
  return (
    <button
      id={`token-option-${token.id}`}
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
      data-testid="token-item"
      data-token-id={token.id}
      className={cn(
        'flex w-full flex-col gap-1 border-b border-dt-border-subtle px-3 py-2 text-left transition-colors',
        isSelected ? 'border-l-2 border-l-dt-accent bg-dt-bg-active' : 'border-l-2 border-l-transparent hover:bg-dt-bg-hover'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT_CLASS[token.status])} aria-hidden />
        <span className="truncate text-xs font-medium text-dt-text">{token.name}</span>
        <span className="shrink-0 rounded bg-dt-bg-elevated px-1.5 py-0.5 font-mono text-2xs text-dt-text-tertiary">#{token.sequenceNumber}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-2xs text-dt-text-tertiary" title={token.domain}>
          {token.domain}
        </span>
        <StatusBadge status={token.status} compact />
      </div>
      <span className="text-2xs text-dt-text-tertiary">
        {token.format === 'jwt' ? formatExpiryCompact(token.expiresAt, now) : token.type}
        {' · '}
        {token.requestIds.length} req
      </span>
    </button>
  );
}
