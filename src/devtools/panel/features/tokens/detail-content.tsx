import { useUIStore } from '@/state/ui-store';
import { useSelectedToken } from '@/hooks/use-selected-token';
import { getScopes } from '@/core/jwt/decoder';
import { stringifyClaimValue } from '@/lib/format';
import { OverviewPanel } from './overview-panel';
import { JsonViewer } from '../../components/ui/json-viewer';
import { EmptyState } from '../../components/ui/empty-state';
import { Shield, Lock, Key, FileText, List } from 'lucide-react';
import type { Token } from '@/types';

function NotDecodable({ token, icon, what }: { token: Token; icon: typeof Shield; what: string }) {
  const description =
    token.format === 'opaque'
      ? `Opaque Bearer tokens have no ${what}. Only the issuing server can interpret this value.`
      : token.formatDetail ?? `This token could not be decoded.`;
  return <EmptyState icon={icon} title={`No ${what} available`} description={description} className="h-full" />;
}

export function DetailContent() {
  const activeDetailTab = useUIStore((s) => s.activeDetailTab);
  const token = useSelectedToken();

  if (!token) {
    return (
      <div role="tabpanel" id={`detail-panel-${activeDetailTab}`} aria-labelledby={`detail-tab-${activeDetailTab}`} className="h-full">
        <EmptyState icon={Shield} title="No token selected" description="Select a token from the list to inspect it" className="h-full" />
      </div>
    );
  }

  const panelClass = 'h-full overflow-auto p-3 scrollbar-thin';
  const panelProps = { className: panelClass, tabIndex: 0 } as const;

  switch (activeDetailTab) {
    case 'overview':
      return <OverviewPanel />;

    case 'payload':
      return (
        <div {...panelProps} role="tabpanel" id="detail-panel-payload" aria-labelledby="detail-tab-payload">
          {token.decoded ? <JsonViewer data={token.decoded.payload} expandDepth={3} /> : <NotDecodable token={token} icon={FileText} what="payload" />}
        </div>
      );

    case 'header':
      return (
        <div {...panelProps} role="tabpanel" id="detail-panel-header" aria-labelledby="detail-tab-header">
          {token.decoded ? <JsonViewer data={token.decoded.header} expandDepth={3} /> : <NotDecodable token={token} icon={Key} what="header" />}
        </div>
      );

    case 'claims': {
      const entries = token.decoded ? Object.entries(token.decoded.payload) : [];
      return (
        <div {...panelProps} role="tabpanel" id="detail-panel-claims" aria-labelledby="detail-tab-claims">
          {token.decoded ? (
            <section className="rounded-lg border border-dt-border bg-dt-bg-secondary">
              <h3 className="border-b border-dt-border px-3 py-2 text-xs font-semibold text-dt-text">All claims ({entries.length})</h3>
              {entries.length === 0 ? (
                <p className="px-3 py-3 text-2xs text-dt-text-tertiary">This token has no claims.</p>
              ) : (
                <table className="w-full table-fixed text-xs">
                  <thead>
                    <tr className="border-b border-dt-border text-left text-2xs uppercase tracking-wider text-dt-text-tertiary">
                      <th scope="col" className="w-32 px-3 py-1.5 font-medium">
                        Claim
                      </th>
                      <th scope="col" className="px-3 py-1.5 font-medium">
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dt-border-subtle">
                    {entries.map(([key, value]) => (
                      <tr key={key}>
                        <td className="break-all px-3 py-1.5 font-mono text-dt-text-tertiary">{key}</td>
                        <td className="break-all px-3 py-1.5 font-mono text-dt-text-secondary">{stringifyClaimValue(value, 2000)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ) : (
            <NotDecodable token={token} icon={List} what="claims" />
          )}
        </div>
      );
    }

    case 'scopes': {
      const scopes = token.decoded ? getScopes(token.decoded.payload) : [];
      return (
        <div {...panelProps} role="tabpanel" id="detail-panel-scopes" aria-labelledby="detail-tab-scopes">
          {scopes.length > 0 ? (
            <section className="rounded-lg border border-dt-border bg-dt-bg-secondary p-3">
              <h3 className="mb-3 text-xs font-semibold text-dt-text">Scopes ({scopes.length})</h3>
              <ul className="flex flex-wrap gap-2">
                {scopes.map((scope) => (
                  <li key={scope} className="rounded-full bg-dt-accent/10 px-2.5 py-1 font-mono text-xs text-dt-accent-strong">
                    {scope}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <EmptyState icon={Lock} title="No scopes found" description="This token has no scope or scp claim" className="h-full" />
          )}
        </div>
      );
    }

    case 'raw':
      return (
        <div {...panelProps} role="tabpanel" id="detail-panel-raw" aria-labelledby="detail-tab-raw">
          <section className="rounded-lg border border-dt-border bg-dt-bg-secondary p-3">
            <h3 className="mb-1 text-xs font-semibold text-dt-text">Raw token</h3>
            <p className="mb-2 text-2xs text-dt-text-tertiary">Sensitive: this is the full credential as sent in the Authorization header.</p>
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-dt-text-secondary" data-testid="raw-token">
              {token.raw}
            </pre>
          </section>
          {token.decoded && (
            <section className="mt-3 rounded-lg border border-dt-border bg-dt-bg-secondary p-3">
              <h3 className="mb-3 text-xs font-semibold text-dt-text">Decoded segments</h3>
              <div className="space-y-3">
                <Segment label="Header" tone="text-dt-accent" text={JSON.stringify(token.decoded.header, null, 2)} />
                <Segment label="Payload" tone="text-dt-success" text={JSON.stringify(token.decoded.payload, null, 2)} />
                <Segment
                  label="Signature (base64url, not verified)"
                  tone="text-dt-warning"
                  text={token.decoded.signaturePresent ? token.decoded.segments[2] : '(empty)'}
                />
              </div>
            </section>
          )}
        </div>
      );
  }
}

function Segment({ label, tone, text }: { label: string; tone: string; text: string }) {
  return (
    <div>
      <span className={`text-2xs font-medium uppercase ${tone}`}>{label}</span>
      <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-dt-text-secondary">{text}</pre>
    </div>
  );
}
