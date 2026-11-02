import { useUIStore } from '@/state/ui-store';
import { cn } from '@/lib/cn';
import type { DetailTab } from '@/types';

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'payload', label: 'Payload' },
  { id: 'header', label: 'Header' },
  { id: 'claims', label: 'Claims' },
  { id: 'scopes', label: 'Scopes' },
  { id: 'raw', label: 'Raw' },
];

export function DetailTabs() {
  const activeDetailTab = useUIStore((s) => s.activeDetailTab);
  const setDetailTab = useUIStore((s) => s.setDetailTab);

  return (
    <div role="tablist" aria-label="Token detail views" className="flex items-center overflow-x-auto border-b border-dt-border bg-dt-bg-secondary px-1">
      {DETAIL_TABS.map((tab) => (
        <button
          key={tab.id}
          id={`detail-tab-${tab.id}`}
          role="tab"
          aria-selected={activeDetailTab === tab.id}
          aria-controls={activeDetailTab === tab.id ? `detail-panel-${tab.id}` : undefined}
          onClick={() => setDetailTab(tab.id)}
          className={cn(
            'relative whitespace-nowrap px-3 py-2 text-xs transition-colors',
            activeDetailTab === tab.id ? 'font-medium text-dt-text' : 'text-dt-text-secondary hover:text-dt-text'
          )}
        >
          {tab.label}
          {activeDetailTab === tab.id && <span className="absolute bottom-0 left-1 right-1 h-0.5 rounded-full bg-dt-accent" aria-hidden />}
        </button>
      ))}
    </div>
  );
}
