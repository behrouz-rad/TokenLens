import { useMemo, useState } from 'react';
import { useSelectedToken } from '@/hooks/use-selected-token';
import { useNow } from '@/state/clock';
import { getAudienceClaim, getNumericDateClaim, getScopes, getStringClaim } from '@/core/jwt/decoder';
import { formatDateTime, stringifyClaimValue } from '@/lib/format';
import { StatusIndicator } from '../../components/ui/status-indicator';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { DiagnosticSeverity, JwtPayload } from '@/types';

interface ClaimRow {
  key: string;
  value: string;
  severity: DiagnosticSeverity;
}

const STANDARD_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'jti', 'scope', 'scp'];

function dateRow(payload: JwtPayload, claim: string, severityFor: (ms: number) => DiagnosticSeverity): ClaimRow | null {
  const result = getNumericDateClaim(payload, claim);
  if (result.kind === 'absent') return null;
  if (result.kind === 'invalid') return { key: claim, value: `${stringifyClaimValue(payload[claim])} (${result.reason})`, severity: 'error' };
  return { key: claim, value: formatDateTime(result.ms), severity: severityFor(result.ms) };
}

function buildSummaryRows(payload: JwtPayload, now: number): ClaimRow[] {
  const rows: ClaimRow[] = [];
  const stringRow = (claim: string, severity: DiagnosticSeverity = 'success') => {
    if (!(claim in payload)) return;
    const value = getStringClaim(payload, claim);
    rows.push(value === null ? { key: claim, value: `${stringifyClaimValue(payload[claim])} (invalid type)`, severity: 'error' } : { key: claim, value, severity });
  };

  stringRow('iss');
  stringRow('sub');
  if ('aud' in payload) {
    const audience = getAudienceClaim(payload);
    rows.push(audience ? { key: 'aud', value: audience.join(', '), severity: 'success' } : { key: 'aud', value: 'invalid type', severity: 'error' });
  }
  const exp = dateRow(payload, 'exp', (ms) => (ms <= now ? 'error' : 'success'));
  if (exp) rows.push(exp);
  const iat = dateRow(payload, 'iat', (ms) => (ms > now + 60_000 ? 'warning' : 'success'));
  if (iat) rows.push(iat);
  const nbf = dateRow(payload, 'nbf', (ms) => (ms > now ? 'warning' : 'success'));
  if (nbf) rows.push(nbf);
  stringRow('jti', 'info');
  const scopes = getScopes(payload);
  if (scopes.length > 0) rows.push({ key: 'scope' in payload ? 'scope' : 'scp', value: scopes.join(' '), severity: 'info' });
  return rows;
}

export function ClaimsSummary() {
  const token = useSelectedToken();
  const now = useNow(1000);
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const payload = token?.decoded?.payload;
    if (!payload) return { summary: [] as ClaimRow[], extra: [] as ClaimRow[] };
    const summary = buildSummaryRows(payload, now);
    const extra: ClaimRow[] = Object.entries(payload)
      .filter(([key]) => !STANDARD_CLAIMS.includes(key))
      .map(([key, value]) => ({ key, value: stringifyClaimValue(value), severity: 'info' as const }));
    return { summary, extra };
  }, [token, now]);

  if (!token?.decoded) return null;

  const totalClaims = Object.keys(token.decoded.payload).length;
  const visibleRows = showAll ? [...rows.summary, ...rows.extra] : rows.summary;

  return (
    <section className="rounded-lg border border-dt-border bg-dt-bg-secondary" aria-labelledby="claims-summary-heading" data-testid="claims-summary">
      <div className="flex items-center justify-between border-b border-dt-border px-3 py-2">
        <h3 id="claims-summary-heading" className="text-xs font-semibold text-dt-text">
          Claims Summary
        </h3>
        <span className="text-2xs text-dt-text-tertiary">
          {visibleRows.length} of {totalClaims}
        </span>
      </div>
      {visibleRows.length === 0 ? (
        <p className="px-3 py-3 text-2xs text-dt-text-tertiary">This token has no claims.</p>
      ) : (
        <dl className="divide-y divide-dt-border-subtle">
          {visibleRows.map((claim) => (
            <div key={claim.key} className="flex items-start gap-3 px-3 py-1.5">
              <dt className="w-16 shrink-0 break-all pt-0.5 font-mono text-2xs text-dt-text-tertiary">{claim.key}</dt>
              <dd className="flex min-w-0 flex-1 items-start gap-3">
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-dt-text-secondary">{claim.value}</span>
                <StatusIndicator severity={claim.severity} dot className="mt-1 shrink-0" />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {rows.extra.length > 0 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="flex w-full items-center justify-center gap-1 border-t border-dt-border px-3 py-1.5 text-2xs text-dt-text-tertiary transition-colors hover:text-dt-text"
        >
          {showAll ? (
            <>
              Show standard claims only <ChevronUp size={10} aria-hidden />
            </>
          ) : (
            <>
              Show all {totalClaims} claims <ChevronDown size={10} aria-hidden />
            </>
          )}
        </button>
      )}
    </section>
  );
}
