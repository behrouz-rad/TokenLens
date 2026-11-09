import { useCallback } from 'react';
import { toast } from 'sonner';
import { useSelectedToken } from '@/hooks/use-selected-token';
import { useNow } from '@/state/clock';
import { getAudienceClaim, getStringClaim } from '@/core/jwt/decoder';
import { describeSignatureState, getSignatureState } from '@/core/diagnostics/engine';
import { copyToClipboard } from '@/lib/clipboard';
import { formatExpiryCompact, previewSecret } from '@/lib/format';
import { StatusBadge } from '../../components/ui/status-badge';
import { Meta } from './token-meta';
import { Copy, Clock } from 'lucide-react';

export function TokenHeader() {
  const token = useSelectedToken();
  const now = useNow(1000);

  const handleCopy = useCallback(async () => {
    if (!token) return;
    const ok = await copyToClipboard(`Bearer ${token.raw}`);
    if (ok) toast.success('Authorization header copied to clipboard');
    else toast.error('Clipboard is unavailable. Use the Raw tab to select the token manually.');
  }, [token]);

  if (!token) return null;

  const payload = token.decoded?.payload;
  const issuer = payload ? getStringClaim(payload, 'iss') : null;
  const subject = payload ? getStringClaim(payload, 'sub') : null;
  const audience = payload ? getAudienceClaim(payload) : null;
  const algorithm = typeof token.decoded?.header.alg === 'string' ? token.decoded.header.alg : null;
  const signatureState = getSignatureState(token);

  return (
    <div className="border-b border-dt-border bg-dt-bg-secondary p-3" data-testid="token-header">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-dt-text" data-testid="token-header-name">
          {token.name}
        </h2>
        <span className="rounded bg-dt-bg-elevated px-1.5 py-0.5 font-mono text-2xs text-dt-text-tertiary">#{token.sequenceNumber}</span>
        <StatusBadge status={token.status} />
        {token.expiresAt !== null && (
          <span className="flex items-center gap-1 text-2xs text-dt-text-tertiary" data-testid="token-header-expiry">
            <Clock size={10} aria-hidden />
            {formatExpiryCompact(token.expiresAt, now)}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0 text-2xs text-dt-text-tertiary">Authorization:</span>
        <code className="min-w-0 flex-1 truncate rounded bg-dt-bg-tertiary px-2 py-1 font-mono text-2xs text-dt-text-secondary" data-testid="token-header-preview">
          Bearer {previewSecret(token.raw, 16)}
        </code>
        <button
          onClick={() => void handleCopy()}
          title="Copy the full Authorization header value (sensitive)"
          aria-label="Copy Bearer token"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-2xs text-dt-text-tertiary transition-colors hover:bg-dt-bg-hover hover:text-dt-text"
        >
          <Copy size={12} aria-hidden />
          Copy
        </button>
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-dt-text-tertiary">
        <Meta label="Issuer" value={issuer} />
        <Meta label="Audience" value={audience?.join(', ') ?? null} />
        <Meta label="Subject" value={subject} />
        <Meta label="Type" value={token.type} title={token.typeBasis} />
        <Meta label="Algorithm" value={algorithm} />
        <Meta label="Signature" value={describeSignatureState(signatureState)} tone={signatureState === 'unsigned' ? 'error' : 'neutral'} />
      </dl>
    </div>
  );
}
