import type { QuickFilterType, TokenStatus } from '@/types';

export const QUICK_FILTERS: { id: QuickFilterType; label: string }[] = [
  { id: 'only-expired', label: 'Only expired' },
  { id: 'expiring-soon', label: 'Expiring soon' },
  { id: 'failed-requests', label: 'Used in failed requests' },
  { id: 'invalid-tokens', label: 'Tokens with errors' },
];

export const STATUS_LABELS: Record<TokenStatus, string> = {
  active: 'Active',
  expiring: 'Expiring',
  expired: 'Expired',
  'not-yet-valid': 'Not yet active',
  'no-expiry': 'No expiry',
  malformed: 'Invalid',
};

export const STATUS_DOT_CLASS: Record<TokenStatus, string> = {
  active: 'bg-dt-success',
  expiring: 'bg-dt-warning animate-pulse-slow',
  expired: 'bg-dt-error',
  'not-yet-valid': 'bg-dt-info',
  'no-expiry': 'bg-dt-text-tertiary',
  malformed: 'bg-dt-error',
};

export function httpStatusTone(status: number): string {
  if (status >= 500) return 'text-dt-error';
  if (status >= 400) return 'text-dt-warning';
  if (status >= 300) return 'text-dt-text-secondary';
  if (status >= 200) return 'text-dt-success';
  return 'text-dt-text-tertiary';
}
