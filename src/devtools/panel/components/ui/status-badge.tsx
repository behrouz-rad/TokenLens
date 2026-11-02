import { cn } from '@/lib/cn';
import { STATUS_LABELS } from '@/lib/token-status';
import type { TokenStatus } from '@/types';

const STATUS_STYLES: Record<TokenStatus, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-dt-bg-elevated', text: 'text-dt-success', dot: 'bg-dt-success' },
  expiring: { bg: 'bg-dt-bg-elevated', text: 'text-dt-warning', dot: 'bg-dt-warning' },
  expired: { bg: 'bg-dt-bg-elevated', text: 'text-dt-error', dot: 'bg-dt-error' },
  'not-yet-valid': { bg: 'bg-dt-bg-elevated', text: 'text-dt-info', dot: 'bg-dt-info' },
  'no-expiry': { bg: 'bg-dt-bg-elevated', text: 'text-dt-text-secondary', dot: 'bg-dt-text-tertiary' },
  malformed: { bg: 'bg-dt-bg-elevated', text: 'text-dt-error', dot: 'bg-dt-error' },
};

interface StatusBadgeProps {
  status: TokenStatus;
  className?: string;
  compact?: boolean;
}

export function StatusBadge({ status, className, compact }: StatusBadgeProps) {
  const style = STATUS_STYLES[status];
  return (
    <span
      title="Temporal status derived from exp/nbf claims. Signatures are not verified."
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        compact ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-[11px]',
        style.bg,
        style.text,
        className
      )}
    >
      <span className={cn('rounded-full', compact ? 'h-1.5 w-1.5' : 'h-2 w-2', style.dot, status === 'expiring' && 'animate-pulse-slow')} />
      {STATUS_LABELS[status]}
    </span>
  );
}
