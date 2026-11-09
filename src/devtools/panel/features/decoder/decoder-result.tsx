import { Clock, Info, KeyRound, LoaderCircle } from 'lucide-react';
import { useDecoderView, type DecoderView } from '@/hooks/use-decoder-view';
import { getAudienceClaim, getStringClaim } from '@/core/jwt/decoder';
import { describeSignatureState, getSignatureState } from '@/core/diagnostics/engine';
import { formatExpiryCompact } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { DecodedToken, DiagnosticSeverity } from '@/types';
import { EmptyState } from '../../components/ui/empty-state';
import { StatusBadge } from '../../components/ui/status-badge';
import { StatusIndicator } from '../../components/ui/status-indicator';
import { ClaimsSummaryCard } from '../tokens/claims-summary';
import { Meta } from '../tokens/token-meta';
import { DiagnosticList } from '../diagnostics/diagnostic-list';
import { DecodedJsonSection } from './decoded-json-section';
import { describeHint, summarizeInspection } from './decoder-labels';

/**
 * Everything known about the Decoder input. While a decode is pending the previous result stays
 * visible but is dimmed and made inert, so it can neither be read as describing the new input nor
 * copied; an emptied field shows the empty state at once.
 */
export function DecoderResult({ scrollable }: { scrollable: boolean }) {
  const view = useDecoderView();
  const summary = summarizeInspection(view.inspection);
  const showEmpty = view.inspection.state === 'empty';

  return (
    <div
      className={cn('@container p-3', scrollable && 'h-full overflow-auto scrollbar-thin')}
      tabIndex={scrollable ? 0 : undefined}
      aria-label={scrollable ? 'Decoded output (scrollable)' : undefined}
      data-testid="decoder-output"
      data-stale={view.stale}
    >
      <p role="status" className="sr-only">
        {view.stale ? '' : summary.state}
      </p>
      {view.stale && (
        <p className="mb-3 flex items-center gap-1.5 text-2xs text-dt-text-tertiary" data-testid="decoder-pending">
          <LoaderCircle size={12} className="animate-spin" aria-hidden />
          {showEmpty ? 'Decoding…' : 'Input changed, decoding…'}
        </p>
      )}
      {showEmpty ? (
        !view.stale && (
          <EmptyState icon={KeyRound} title="Paste a JWT to inspect its header and payload." description="Decoded locally. Signature not verified." className="h-full" />
        )
      ) : (
        <div inert={view.stale} className={cn('flex flex-col gap-3 transition-opacity', view.stale && 'opacity-40')} data-testid="decoder-result">
          <ResultSummary view={view} />
          <ResultDetails view={view} />
        </div>
      )}
    </div>
  );
}

function ResultSummary({ view }: { view: DecoderView }) {
  const { inspection, status, expiresAt, now } = view;
  const summary = summarizeInspection(inspection);
  const hints = inspection.state === 'analyzed' || inspection.state === 'too-large' ? inspection.hints : [];
  const decoded = inspection.state === 'analyzed' ? inspection.analysis.decoded : null;

  return (
    <section className="rounded-lg border border-dt-border bg-dt-bg-secondary p-3" aria-label="Decoding result" data-testid="decoder-summary">
      {decoded && inspection.state === 'analyzed' ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold text-dt-text" data-testid="decoder-token-type">
              {inspection.classification.type}
            </h2>
            {status && <StatusBadge status={status} />}
            {expiresAt !== null && (
              <span className="flex items-center gap-1 text-2xs text-dt-text-tertiary" data-testid="decoder-expiry">
                <Clock size={10} aria-hidden />
                {formatExpiryCompact(expiresAt, now)}
              </span>
            )}
          </div>
          <p className="mt-1 text-2xs text-dt-text-tertiary">{inspection.classification.basis}.</p>
          <TokenFacts decoded={decoded} />
        </>
      ) : (
        summary.feedback && <Feedback {...summary.feedback} />
      )}
      {hints.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-dt-border-subtle pt-2 text-2xs text-dt-text-secondary" aria-label="Input notes" data-testid="decoder-hints">
          {hints.map((hint) => (
            <li key={hint.kind} className="flex items-start gap-1.5" data-hint={hint.kind}>
              <Info size={12} className={cn('mt-px shrink-0', hint.kind === 'internal-whitespace' || hint.kind === 'jwt-like-segment-count' ? 'text-dt-warning' : 'text-dt-info')} aria-hidden />
              {describeHint(hint)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TokenFacts({ decoded }: { decoded: DecodedToken }) {
  const { header, payload } = decoded;
  const signatureState = getSignatureState({ decoded });
  return (
    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-dt-text-tertiary" data-testid="decoder-facts">
      <Meta label="Algorithm" value={typeof header.alg === 'string' ? header.alg : null} />
      <Meta label="Signature" value={describeSignatureState(signatureState)} tone={signatureState === 'unsigned' ? 'error' : 'neutral'} />
      <Meta label="Issuer" value={getStringClaim(payload, 'iss')} />
      <Meta label="Audience" value={getAudienceClaim(payload)?.join(', ') ?? null} />
      <Meta label="Subject" value={getStringClaim(payload, 'sub')} />
    </dl>
  );
}

function Feedback({ severity, title, description }: { severity: DiagnosticSeverity; title: string; description: string }) {
  return (
    <div className="flex items-start gap-2" data-testid="decoder-feedback" data-severity={severity}>
      <StatusIndicator severity={severity} size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-dt-text">{title}</h2>
        <p className="mt-0.5 break-words text-xs text-dt-text-secondary">{description}</p>
      </div>
    </div>
  );
}

function ResultDetails({ view }: { view: DecoderView }) {
  const { inspection, checks, now } = view;
  if (inspection.state !== 'analyzed') return null;
  const { analysis, json } = inspection;

  return (
    <>
      {analysis.format === 'jwt' && json && (
        <>
          <DecodedJsonSection section="header" data={analysis.decoded.header} rawJson={json.header} />
          <DecodedJsonSection section="payload" data={analysis.decoded.payload} rawJson={json.payload} />
        </>
      )}
      <div className={cn('grid grid-cols-1 items-start gap-3', analysis.format === 'jwt' && '@2xl:grid-cols-2')}>
        {analysis.format === 'jwt' && <ClaimsSummaryCard payload={analysis.decoded.payload} now={now} />}
        <section className="min-w-0 rounded-lg border border-dt-border bg-dt-bg-secondary" aria-label="Diagnostics" data-testid="decoder-diagnostics">
          <div className="flex flex-wrap items-center justify-between gap-x-2 border-b border-dt-border px-3 py-2">
            <h3 className="text-xs font-semibold text-dt-text">Diagnostics</h3>
            <span className="text-2xs text-dt-text-tertiary">Decoded locally · signature not verified</span>
          </div>
          <DiagnosticList checks={checks} />
        </section>
      </div>
    </>
  );
}
