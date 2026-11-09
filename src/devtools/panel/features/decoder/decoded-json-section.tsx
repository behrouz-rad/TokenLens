import { useId } from 'react';
import { Copy } from 'lucide-react';
import { useDecoderStore, type DecodedSection } from '@/state/decoder-store';
import { JsonViewer } from '../../components/ui/json-viewer';
import { ModeToggle } from '../../components/ui/mode-toggle';
import { copyWithFeedback } from './copy-with-feedback';

const TITLES: Record<DecodedSection, string> = { header: 'Header', payload: 'Payload' };

interface DecodedJsonSectionProps {
  section: DecodedSection;
  data: Record<string, unknown>;
  /** The segment's JSON exactly as encoded in the token. */
  rawJson: string;
}

/**
 * Read-only view of one decoded segment. Pretty renders the parsed object; Raw shows the original
 * JSON text, which is what to rely on when key order, duplicate keys or large numbers matter.
 * The body uses the base background, like the Overview's JSON viewers, because the JSON colours
 * are tuned for AA contrast against it.
 */
export function DecodedJsonSection({ section, data, rawJson }: DecodedJsonSectionProps) {
  const view = useDecoderStore((s) => s.views[section]);
  const setView = useDecoderStore((s) => s.setView);
  const headingId = useId();
  const title = TITLES[section];
  const noun = title.toLowerCase();

  const handleCopy = () =>
    copyWithFeedback(view === 'pretty' ? JSON.stringify(data, null, 2) : rawJson, view === 'pretty' ? `${title} JSON copied` : `Raw ${noun} JSON copied`);

  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-dt-border bg-dt-bg" aria-labelledby={headingId} data-testid={`decoded-${section}`} data-view={view}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dt-border bg-dt-bg-secondary px-3 py-2">
        <h3 id={headingId} className="text-xs font-semibold text-dt-text">
          {title}
        </h3>
        <div className="flex items-center gap-1">
          <ModeToggle value={view} onChange={(mode) => setView(section, mode)} label={`${title} display mode`} />
          <button
            type="button"
            onClick={() => void handleCopy()}
            title={view === 'pretty' ? `Copy the ${noun} as formatted JSON` : `Copy the ${noun} JSON exactly as encoded in the token`}
            aria-label={`Copy ${noun} JSON`}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-dt-text-tertiary transition-colors hover:bg-dt-bg-hover hover:text-dt-text"
          >
            <Copy size={12} aria-hidden />
            Copy
          </button>
        </div>
      </div>
      <div className="p-3">
        {view === 'pretty' ? (
          <JsonViewer data={data} expandDepth={3} />
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-dt-text-secondary" data-testid={`decoded-${section}-raw`}>
            {rawJson}
          </pre>
        )}
      </div>
    </section>
  );
}
