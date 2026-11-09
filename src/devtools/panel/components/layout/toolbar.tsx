import { useUIStore } from '@/state/ui-store';
import { useCaptureStore } from '@/state/capture-store';
import { clearCaptureWithFeedback } from '@/state/capture-actions';
import { useTokenListView } from '@/hooks/use-filtered-tokens';
import { cn } from '@/lib/cn';
import { IconButton } from '../ui/icon-button';
import { Popover } from '../ui/popover';
import { FiltersPopoverContent } from './filters-popover';
import { SettingsPopoverContent } from './settings-popover';
import { CircleDot, Sun, Moon, Settings, Trash, SlidersHorizontal, Shield, Pause } from 'lucide-react';
import type { MainTab } from '@/types';

const MAIN_TABS: { id: MainTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'requests', label: 'Requests' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'decoder', label: 'Decoder' },
];

/**
 * The Filters popover edits the token-inventory filter, which only the Overview's token list
 * applies. Requests and Timeline carry their own inline filters, so the control is shown only
 * where it has an effect; a global-looking button on those sections would suggest it narrows them.
 * Below 640 px the section navigation moves to its own row so every section stays visible.
 */
export function Toolbar() {
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const isRecording = useUIStore((s) => s.isRecording);
  const toggleRecording = useUIStore((s) => s.toggleRecording);
  const activeMainTab = useUIStore((s) => s.activeMainTab);
  const setMainTab = useUIStore((s) => s.setMainTab);
  const { isFiltered, matching } = useTokenListView();
  const filter = useCaptureStore((s) => s.filter);
  const activeFilterCount = [filter.search.trim(), filter.statusFilter, filter.quickFilter].filter(Boolean).length;

  return (
    <header className="@container shrink-0">
      <div className="flex min-h-9 flex-wrap items-center gap-1 border-b border-dt-border bg-dt-bg-secondary px-2">
        <div className="mr-3 flex items-center gap-2">
          <Shield size={16} className="text-dt-accent" aria-hidden />
          <span className="text-xs font-semibold tracking-tight text-dt-text">TokenLens</span>
          <span className="rounded bg-dt-bg-elevated px-1.5 py-0.5 text-2xs font-medium text-dt-text-secondary" data-testid="app-version">
            v{__APP_VERSION__}
          </span>
        </div>

        <div className="mx-1 h-4 w-px bg-dt-border @max-[40rem]:hidden" />

        <nav
          aria-label="Main sections"
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto @max-[40rem]:order-last @max-[40rem]:-mx-2 @max-[40rem]:basis-[calc(100%+1rem)] @max-[40rem]:border-t @max-[40rem]:border-dt-border @max-[40rem]:px-2 @max-[40rem]:py-1"
        >
          {MAIN_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setMainTab(tab.id)}
              aria-current={activeMainTab === tab.id ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap rounded px-2.5 py-1 text-xs transition-colors',
                'hover:bg-dt-bg-hover hover:text-dt-text',
                activeMainTab === tab.id ? 'bg-dt-bg-active font-medium text-dt-text' : 'text-dt-text-secondary'
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        <div className="flex items-center gap-0.5">
          <button
            onClick={toggleRecording}
            aria-pressed={isRecording}
            title={isRecording ? 'Recording: new requests are captured. Click to pause.' : 'Paused: new requests are ignored. Click to resume.'}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors',
              isRecording ? 'text-dt-error' : 'text-dt-text-tertiary hover:text-dt-text'
            )}
          >
            {isRecording ? <CircleDot size={12} className="animate-pulse" aria-hidden /> : <Pause size={12} aria-hidden />}
            <span>{isRecording ? 'Recording' : 'Paused'}</span>
          </button>

          <div className="mx-1 h-4 w-px bg-dt-border" />

          <IconButton
            icon={theme === 'dark' ? Sun : Moon}
            label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggleTheme}
          />
          {activeMainTab === 'overview' && (
            <Popover
              title="Filters"
              trigger={<IconButton icon={SlidersHorizontal} label="Filters" active={isFiltered} badge={activeFilterCount} />}
            >
              <FiltersPopoverContent matchingCount={matching.length} />
            </Popover>
          )}
          <Popover title="Settings" trigger={<IconButton icon={Settings} label="Settings" />}>
            <SettingsPopoverContent />
          </Popover>
          <IconButton icon={Trash} label="Clear captured tokens and requests" onClick={clearCaptureWithFeedback} />
        </div>
      </div>
    </header>
  );
}
