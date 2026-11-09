import { cn } from '@/lib/cn';

export type ViewMode = 'pretty' | 'raw';

interface ModeToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  /** Accessible name of the group, e.g. "Payload display mode". */
  label: string;
  prettyDisabled?: boolean;
}

/** Pretty / Raw segmented control shared by the JSON viewers. */
export function ModeToggle({ value, onChange, label, prettyDisabled = false }: ModeToggleProps) {
  const segment = (mode: ViewMode, text: string) => (
    <button
      type="button"
      onClick={() => onChange(mode)}
      aria-pressed={value === mode}
      disabled={prettyDisabled && mode === 'pretty'}
      className={cn(
        'rounded px-2 py-0.5 text-2xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        value === mode ? 'bg-dt-bg-elevated text-dt-text shadow-sm' : 'text-dt-text-tertiary hover:text-dt-text'
      )}
    >
      {text}
    </button>
  );
  return (
    <div className="flex rounded bg-dt-bg-tertiary p-0.5" role="group" aria-label={label}>
      {segment('pretty', 'Pretty')}
      {segment('raw', 'Raw')}
    </div>
  );
}
