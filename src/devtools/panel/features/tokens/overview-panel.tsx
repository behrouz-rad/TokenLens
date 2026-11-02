import { useSelectedToken } from '@/hooks/use-selected-token';
import { ClaimsSummary } from './claims-summary';
import { TokenTimeline } from '../timeline/token-timeline';
import { RequestTable } from '../requests/request-table';
import { EmptyState } from '../../components/ui/empty-state';
import { Shield, Info } from 'lucide-react';

export function OverviewPanel() {
  const token = useSelectedToken();

  if (!token) {
    return <EmptyState icon={Shield} title="No token selected" description="Select a token from the list to inspect its details" className="h-full" />;
  }

  return (
    <div className="@container h-full overflow-auto p-3 scrollbar-thin" role="tabpanel" tabIndex={0} id="detail-panel-overview" aria-labelledby="detail-tab-overview">
      <div className="flex flex-col gap-3">
        {!token.decoded && (
          <div className="flex items-start gap-2 rounded-lg border border-dt-border bg-dt-bg-secondary px-3 py-2 text-xs text-dt-text-secondary" data-testid="non-jwt-notice">
            <Info size={14} className="mt-0.5 shrink-0 text-dt-info" aria-hidden />
            <p>
              <span className="font-medium text-dt-text">{token.type}.</span> {token.typeBasis}. Request correlation and HTTP evidence are still available below.
            </p>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          {token.decoded && <ClaimsSummary />}
          <TokenTimeline />
        </div>
        <RequestTable />
      </div>
    </div>
  );
}
