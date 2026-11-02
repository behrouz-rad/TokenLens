import { useMemo, useState } from 'react';
import { useSelectedToken, useTokenRequests } from '@/hooks/use-selected-token';
import { requestHost, type RequestRow } from '@/hooks/use-request-explorer';
import { RequestGrid, REQUEST_ROW_HEIGHT } from './request-grid';
import { ChevronDown, ChevronUp } from 'lucide-react';

const COLLAPSED_ROWS = 6;

/** Requests that carried the selected token, shown inside the Overview. */
export function RequestTable() {
  const token = useSelectedToken();
  const requests = useTokenRequests(token);
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo<RequestRow[]>(() => requests.map((request) => ({ request, token, host: requestHost(request.url) })), [requests, token]);
  const maxHeight = expanded ? '60vh' : `${REQUEST_ROW_HEIGHT * COLLAPSED_ROWS + 30}px`;

  return (
    <section className="rounded-lg border border-dt-border bg-dt-bg-secondary" aria-labelledby="request-table-heading" data-testid="request-table">
      <div className="flex items-center justify-between border-b border-dt-border px-3 py-2">
        <h3 id="request-table-heading" className="text-xs font-semibold text-dt-text">
          Used in requests ({requests.length})
        </h3>
      </div>

      {requests.length === 0 ? (
        <p className="px-3 py-3 text-2xs text-dt-text-tertiary">No requests recorded for this token.</p>
      ) : (
        <RequestGrid rows={rows} ariaLabel="Requests for the selected token (scrollable)" style={{ maxHeight }} />
      )}

      {requests.length > COLLAPSED_ROWS && (
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 border-t border-dt-border px-3 py-1.5 text-2xs text-dt-accent transition-colors hover:text-dt-accent-hover"
        >
          {expanded ? (
            <>
              Show fewer <ChevronUp size={10} aria-hidden />
            </>
          ) : (
            <>
              Show all {requests.length} requests <ChevronDown size={10} aria-hidden />
            </>
          )}
        </button>
      )}
    </section>
  );
}
