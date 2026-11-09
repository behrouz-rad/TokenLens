import { useMemo } from 'react';
import { useDecoderStore, isDecoderResultStale } from '@/state/decoder-store';
import { useUIStore } from '@/state/ui-store';
import { useNow } from '@/state/clock';
import { computeTokenStatus, getTemporalBounds } from '@/core/jwt/decoder';
import { toDiagnosticSubject, type CredentialInspection } from '@/core/jwt/credential-input';
import { runDiagnostics } from '@/core/diagnostics/engine';
import type { DiagnosticCheck, TokenStatus } from '@/types';

export interface DecoderView {
  input: string;
  inspection: CredentialInspection;
  stale: boolean;
  now: number;
  /** Temporal status for a decoded JWT; null for every other result. */
  status: TokenStatus | null;
  expiresAt: number | null;
  checks: DiagnosticCheck[];
}

/**
 * Evaluates the decoder's current result against the shared 1 s clock, so expiry and not-before
 * results stay current while the Decoder is on screen. Only token-only rules run: there is no
 * request evidence for a pasted token.
 */
export function useDecoderView(): DecoderView {
  const input = useDecoderStore((s) => s.input);
  const inspectedInput = useDecoderStore((s) => s.inspectedInput);
  const inspection = useDecoderStore((s) => s.inspection);
  const expiringThresholdMs = useUIStore((s) => s.expiringThresholdMs);
  const now = useNow(1000);

  const evaluated = useMemo(() => {
    if (inspection.state !== 'analyzed') return { status: null, expiresAt: null, checks: [] };
    const { analysis } = inspection;
    return {
      status: analysis.format === 'jwt' ? computeTokenStatus(analysis.format, analysis.decoded, now, expiringThresholdMs) : null,
      expiresAt: getTemporalBounds(analysis.decoded).expiresAt,
      checks: runDiagnostics(toDiagnosticSubject(analysis), now, expiringThresholdMs),
    };
  }, [inspection, now, expiringThresholdMs]);

  return { input, inspection, stale: isDecoderResultStale({ input, inspectedInput }), now, ...evaluated };
}
