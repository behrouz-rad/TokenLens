import { cn } from '@/lib/cn';
import { CircleCheck, TriangleAlert, CircleX, Info, type LucideIcon } from 'lucide-react';
import type { DiagnosticSeverity } from '@/types';

const SEVERITY_CONFIG: Record<DiagnosticSeverity, { icon: LucideIcon; color: string; bg: string; label: string }> = {
  success: { icon: CircleCheck, color: 'text-dt-success', bg: 'bg-dt-success', label: 'OK' },
  warning: { icon: TriangleAlert, color: 'text-dt-warning', bg: 'bg-dt-warning', label: 'Warning' },
  error: { icon: CircleX, color: 'text-dt-error', bg: 'bg-dt-error', label: 'Error' },
  info: { icon: Info, color: 'text-dt-info', bg: 'bg-dt-info', label: 'Info' },
};

interface StatusIndicatorProps {
  severity: DiagnosticSeverity;
  size?: number;
  className?: string;
  dot?: boolean;
}

export function StatusIndicator({ severity, size = 14, className, dot }: StatusIndicatorProps) {
  const config = SEVERITY_CONFIG[severity];
  if (dot) {
    return <span role="img" aria-label={config.label} className={cn('inline-block h-2 w-2 rounded-full', config.bg, className)} />;
  }
  const Icon = config.icon;
  return <Icon size={size} role="img" aria-label={config.label} className={cn(config.color, className)} />;
}
