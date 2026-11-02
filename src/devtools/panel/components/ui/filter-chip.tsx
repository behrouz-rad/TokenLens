import { cn } from '@/lib/cn';

interface FilterChipProps {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  className?: string;
}

/** Toggle button used for status, category and quick filters; `aria-pressed` carries the state. */
export function FilterChip({ label, count, active, onClick, className }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center justify-between gap-2 rounded px-2 py-1 text-xs transition-colors',
        active ? 'bg-dt-accent/15 text-dt-accent-strong' : 'text-dt-text-secondary hover:bg-dt-bg-hover hover:text-dt-text',
        className
      )}
    >
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="text-2xs text-dt-text-tertiary">{count}</span>}
    </button>
  );
}
