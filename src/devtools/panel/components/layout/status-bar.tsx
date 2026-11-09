import { useMemo } from 'react';
import { useCaptureStore } from '@/state/capture-store';
import { useUIStore } from '@/state/ui-store';
import { useTokenListView } from '@/hooks/use-filtered-tokens';
import { useRequestExplorer } from '@/hooks/use-request-explorer';
import { useGlobalTimeline } from '@/hooks/use-global-timeline';
import { cn } from '@/lib/cn';
import { pluralize } from '@/lib/format';
import { Trash } from 'lucide-react';
import { clearCaptureWithFeedback } from '@/state/capture-actions';
import { isDecoderResultStale, useDecoderStore } from '@/state/decoder-store';
import { summarizeInspection } from '../../features/decoder/decoder-labels';

const FOOTER_CLASS = 'flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-dt-border bg-dt-bg-secondary px-3 text-2xs text-dt-text-tertiary';

/**
 * The Decoder works on pasted input, not on captured traffic, so in that section the bar reports
 * the local decoding state instead of capture counts and capture filters.
 */
export function StatusBar() {
  const activeMainTab = useUIStore((s) => s.activeMainTab);
  return activeMainTab === 'decoder' ? <DecoderStatusBar /> : <CaptureStatusBar />;
}

function DecoderStatusBar() {
  const inspection = useDecoderStore((s) => s.inspection);
  const stale = useDecoderStore(isDecoderResultStale);
  return (
    <footer className={FOOTER_CLASS} aria-label="Decoder status">
      <span data-testid="status-decoder-scope" className="truncate">
        Decoder · local only, not added to the capture session
      </span>
      <div className="flex-1" />
      <span data-testid="status-decoder-state" className="truncate">
        {stale ? 'Decoding…' : summarizeInspection(inspection).state}
      </span>
    </footer>
  );
}

function CaptureStatusBar() {
  const requests = useCaptureStore((s) => s.session.requests);
  const tokens = useCaptureStore((s) => s.session.tokens);
  const counters = useCaptureStore((s) => s.session.counters);
  const isRecording = useUIStore((s) => s.isRecording);
  const activeMainTab = useUIStore((s) => s.activeMainTab);

  const stats = useMemo(() => {
    let s2xx = 0;
    let s3xx = 0;
    let s4xx = 0;
    let s5xx = 0;
    for (const r of requests.values()) {
      if (r.status >= 500) s5xx += 1;
      else if (r.status >= 400) s4xx += 1;
      else if (r.status >= 300) s3xx += 1;
      else if (r.status >= 200) s2xx += 1;
    }
    return { total: requests.size, s2xx, s3xx, s4xx, s5xx };
  }, [requests]);

  const observedWithoutToken = Math.max(0, counters.observedRequests - stats.total - counters.evictedRequests);

  return (
    <footer className={FOOTER_CLASS} aria-label="Capture summary">
      <span data-testid="status-token-count">Captured {pluralize(tokens.size, 'token')}</span>
      <Divider />
      <span data-testid="status-request-count" title={`${observedWithoutToken} observed requests carried no Bearer token`}>
        Requests with Bearer: {stats.total}
      </span>
      <div className="flex items-center gap-2" data-testid="status-http-breakdown">
        <span className={cn(stats.s2xx > 0 && 'text-dt-success')}>2xx: {stats.s2xx}</span>
        <span>3xx: {stats.s3xx}</span>
        <span className={cn(stats.s4xx > 0 && 'text-dt-warning')}>4xx: {stats.s4xx}</span>
        <span className={cn(stats.s5xx > 0 && 'text-dt-error')}>5xx: {stats.s5xx}</span>
      </div>
      {(counters.evictedTokens > 0 || counters.evictedRequests > 0) && (
        <>
          <Divider />
          <span title="Oldest records were dropped to stay within the capture limits (see Settings)">
            Evicted: {counters.evictedTokens} tokens, {counters.evictedRequests} requests
          </span>
        </>
      )}
      {!isRecording && (
        <>
          <Divider />
          <span className="text-dt-warning" data-testid="status-paused">
            Paused · {counters.ignoredWhilePaused} skipped
          </span>
        </>
      )}

      <div className="flex-1" />

      {activeMainTab === 'requests' ? <RequestFilterSummary /> : activeMainTab === 'timeline' ? <TimelineFilterSummary /> : <TokenFilterSummary />}

      <button
        onClick={clearCaptureWithFeedback}
        className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-dt-bg-hover hover:text-dt-text"
        aria-label="Clear capture session"
      >
        Clear
        <Trash size={10} aria-hidden />
      </button>
    </footer>
  );
}

/**
 * Each section filters its own dataset, so the summary describes the section on screen. One small
 * component per section keeps only the active section's derivation mounted.
 */
function FilterSummary({ isFiltered, shown, total, noun }: { isFiltered: boolean; shown: number; total: number; noun: string }) {
  return (
    <span className={cn(isFiltered && 'text-dt-accent')} data-testid="status-filter-summary">
      {isFiltered ? `Showing ${shown} of ${total} ${noun}` : 'Showing all data'}
    </span>
  );
}

function TokenFilterSummary() {
  const total = useCaptureStore((s) => s.session.tokens.size);
  const { matching, isFiltered } = useTokenListView();
  return <FilterSummary isFiltered={isFiltered} shown={matching.length} total={total} noun="tokens" />;
}

function RequestFilterSummary() {
  const { rows, total, isFiltered } = useRequestExplorer();
  return <FilterSummary isFiltered={isFiltered} shown={rows.length} total={total} noun="requests" />;
}

function TimelineFilterSummary() {
  const { rows, total, isFiltered } = useGlobalTimeline();
  return <FilterSummary isFiltered={isFiltered} shown={rows.length} total={total} noun="events" />;
}

function Divider() {
  return <div className="h-3 w-px bg-dt-border" aria-hidden />;
}
