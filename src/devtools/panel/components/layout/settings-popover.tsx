import { useUIStore } from '@/state/ui-store';

const THRESHOLD_OPTIONS_MINUTES = [1, 2, 5, 10, 15, 30, 60];

export function SettingsPopoverContent() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const clearOnNavigation = useUIStore((s) => s.clearOnNavigation);
  const setClearOnNavigation = useUIStore((s) => s.setClearOnNavigation);
  const expiringThresholdMs = useUIStore((s) => s.expiringThresholdMs);
  const setExpiringThresholdMs = useUIStore((s) => s.setExpiringThresholdMs);
  const limits = useUIStore((s) => s.limits);
  const setLimits = useUIStore((s) => s.setLimits);

  const thresholdMinutes = Math.round(expiringThresholdMs / 60_000);
  const thresholdOptions = THRESHOLD_OPTIONS_MINUTES.includes(thresholdMinutes)
    ? THRESHOLD_OPTIONS_MINUTES
    : [...THRESHOLD_OPTIONS_MINUTES, thresholdMinutes].sort((a, b) => a - b);

  const fieldClass =
    'w-full rounded border border-transparent bg-dt-bg-tertiary px-2 py-1 text-xs text-dt-text focus:border-dt-accent focus:outline-none';

  return (
    <div className="flex flex-col gap-3" data-testid="settings-popover">
      <label className="flex flex-col gap-1">
        <span className="text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary">Theme</span>
        <select value={theme} onChange={(e) => setTheme(e.target.value === 'light' ? 'light' : 'dark')} className={fieldClass}>
          <option value="dark">Dark (default)</option>
          <option value="light">Light</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary">Expiring-soon threshold</span>
        <select value={thresholdMinutes} onChange={(e) => setExpiringThresholdMs(Number(e.target.value) * 60_000)} className={fieldClass}>
          {thresholdOptions.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minute{minutes === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={clearOnNavigation} onChange={(e) => setClearOnNavigation(e.target.checked)} className="accent-(--dt-accent)" />
        <span>Clear captured data when the page navigates</span>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary">Capture limits (oldest evicted first)</legend>
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>Max tokens</span>
          <input
            type="number"
            min={10}
            max={10_000}
            step={10}
            value={limits.maxTokens}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value >= 10 && value <= 10_000) setLimits({ ...limits, maxTokens: value });
            }}
            className={`${fieldClass} w-24 text-right`}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>Max requests</span>
          <input
            type="number"
            min={100}
            max={100_000}
            step={100}
            value={limits.maxRequests}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value >= 100 && value <= 100_000) setLimits({ ...limits, maxRequests: value });
            }}
            className={`${fieldClass} w-24 text-right`}
          />
        </label>
      </fieldset>

      <p className="border-t border-dt-border pt-2 text-2xs text-dt-text-tertiary">
        Only these preferences are saved. Captured tokens stay in memory and are discarded when DevTools closes.
      </p>
    </div>
  );
}
