import { StatusIndicator } from '../../components/ui/status-indicator';
import { cn } from '@/lib/cn';
import type { DiagnosticCheck } from '@/types';

export function DiagnosticList({ checks }: { checks: readonly DiagnosticCheck[] }) {
  return (
    <ul className="divide-y divide-dt-border-subtle">
      {checks.map((check) => (
        <DiagnosticRow key={check.id} check={check} />
      ))}
    </ul>
  );
}

function DiagnosticRow({ check }: { check: DiagnosticCheck }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2" data-testid="diagnostic-row" data-check-id={check.id} data-severity={check.severity}>
      <div className="min-w-0 flex-1">
        <span className="text-xs text-dt-text">{check.label}</span>
        <p
          className={cn(
            'mt-0.5 break-words text-2xs',
            check.severity === 'error' ? 'text-dt-error' : check.severity === 'warning' ? 'text-dt-warning' : 'text-dt-text-secondary'
          )}
        >
          {check.description}
        </p>
        {check.details && <p className="mt-0.5 break-words text-2xs italic text-dt-text-tertiary">{check.details}</p>}
      </div>
      <StatusIndicator severity={check.severity} size={14} className="mt-0.5 shrink-0" />
    </li>
  );
}
