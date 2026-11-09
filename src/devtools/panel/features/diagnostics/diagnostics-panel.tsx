import { useMemo } from 'react';
import { useSelectedToken, useTokenRequests } from '@/hooks/use-selected-token';
import { useUIStore } from '@/state/ui-store';
import { useNow } from '@/state/clock';
import { runDiagnostics, runRequestDiagnostics } from '@/core/diagnostics/engine';
import { DiagnosticList } from './diagnostic-list';

export function DiagnosticsPanel() {
  const token = useSelectedToken();
  const requests = useTokenRequests(token);
  const expiringThresholdMs = useUIStore((s) => s.expiringThresholdMs);
  const now = useNow(1000);

  const tokenChecks = useMemo(() => (token ? runDiagnostics(token, now, expiringThresholdMs) : []), [token, now, expiringThresholdMs]);
  const requestChecks = useMemo(() => runRequestDiagnostics(requests), [requests]);

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center p-4" data-testid="diagnostics-empty">
        <p className="text-xs text-dt-text-tertiary">Select a token to view diagnostics</p>
      </div>
    );
  }

  return (
    <section className="flex flex-col" aria-labelledby="diagnostics-heading" data-testid="diagnostics-panel">
      <div className="flex items-center justify-between border-b border-dt-border px-3 py-2">
        <h3 id="diagnostics-heading" className="text-xs font-semibold text-dt-text">
          Diagnostics
        </h3>
        <span className="text-2xs text-dt-text-tertiary">Decoded locally · signature not verified</span>
      </div>

      <DiagnosticList checks={tokenChecks} />

      {requestChecks.length > 0 && (
        <>
          <div className="border-t border-dt-border px-3 py-1.5 text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary">
            HTTP evidence
          </div>
          <DiagnosticList checks={requestChecks} />
        </>
      )}
    </section>
  );
}
