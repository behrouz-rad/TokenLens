import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useSelectedToken } from '@/hooks/use-selected-token';
import { useUIStore } from '@/state/ui-store';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { JsonViewer } from '../../components/ui/json-viewer';
import { Copy, Maximize2, Minimize2, UnfoldVertical, FoldVertical } from 'lucide-react';

type Mode = 'pretty' | 'raw';

export function PayloadViewer({ maximized = false }: { maximized?: boolean }) {
  const token = useSelectedToken();
  const setMaximized = useUIStore((s) => s.setPayloadMaximized);
  const [mode, setMode] = useState<Mode>('pretty');
  const [expandAll, setExpandAll] = useState(false);

  const decoded = token?.decoded ?? null;
  const effectiveMode: Mode = decoded ? mode : 'raw';

  const handleCopy = useCallback(async () => {
    if (!token) return;
    const text = effectiveMode === 'pretty' && decoded ? JSON.stringify(decoded.payload, null, 2) : token.raw;
    const ok = await copyToClipboard(text);
    if (ok) toast.success(effectiveMode === 'pretty' ? 'Payload JSON copied' : 'Raw token copied (sensitive)');
    else toast.error('Clipboard is unavailable in this context');
  }, [token, decoded, effectiveMode]);

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center p-4" data-testid="payload-viewer-empty">
        <p className="text-xs text-dt-text-tertiary">Select a token to view its payload</p>
      </div>
    );
  }

  const segmentButton = (value: Mode, label: string) => (
    <button
      onClick={() => setMode(value)}
      aria-pressed={effectiveMode === value}
      disabled={!decoded && value === 'pretty'}
      className={cn(
        'rounded px-2 py-0.5 text-2xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        effectiveMode === value ? 'bg-dt-bg-elevated text-dt-text shadow-sm' : 'text-dt-text-tertiary hover:text-dt-text'
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col" data-testid="payload-viewer">
      <div className="flex items-center justify-between gap-2 border-b border-dt-border px-3 py-2">
        <h3 className="text-xs font-semibold text-dt-text">{decoded ? 'Payload' : 'Token value'}</h3>
        <div className="flex items-center gap-1">
          <div className="flex rounded bg-dt-bg-tertiary p-0.5" role="group" aria-label="Payload display mode">
            {segmentButton('pretty', 'Pretty')}
            {segmentButton('raw', 'Raw')}
          </div>
          {decoded && effectiveMode === 'pretty' && (
            <button
              onClick={() => setExpandAll((v) => !v)}
              aria-pressed={expandAll}
              title={expandAll ? 'Collapse nested values' : 'Expand all nested values'}
              aria-label={expandAll ? 'Collapse all' : 'Expand all'}
              className="rounded p-1 text-dt-text-tertiary transition-colors hover:bg-dt-bg-hover hover:text-dt-text"
            >
              {expandAll ? <FoldVertical size={12} /> : <UnfoldVertical size={12} />}
            </button>
          )}
          <button
            onClick={() => void handleCopy()}
            title={effectiveMode === 'pretty' ? 'Copy payload as JSON' : 'Copy raw token (sensitive)'}
            aria-label={effectiveMode === 'pretty' ? 'Copy payload JSON' : 'Copy raw token'}
            className="rounded p-1 text-dt-text-tertiary transition-colors hover:bg-dt-bg-hover hover:text-dt-text"
          >
            <Copy size={12} />
          </button>
          <button
            onClick={() => setMaximized(!maximized)}
            title={maximized ? 'Restore payload panel' : 'Maximize payload panel'}
            aria-label={maximized ? 'Restore payload panel' : 'Maximize payload panel'}
            className="rounded p-1 text-dt-text-tertiary transition-colors hover:bg-dt-bg-hover hover:text-dt-text"
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 scrollbar-thin" tabIndex={0} aria-label="Payload content (scrollable)">
        {effectiveMode === 'pretty' && decoded ? (
          <JsonViewer data={decoded.payload} expandDepth={expandAll ? Number.POSITIVE_INFINITY : 2} />
        ) : (
          <>
            {!decoded && (
              <p className="mb-2 text-2xs text-dt-text-tertiary">
                {token.format === 'opaque' ? 'Opaque Bearer token: no decodable payload.' : token.formatDetail ?? 'This token could not be decoded.'}
              </p>
            )}
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-dt-text-secondary" data-testid="payload-raw">
              {token.raw}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
