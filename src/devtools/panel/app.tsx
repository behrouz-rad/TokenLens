import { useCallback, useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import * as Dialog from '@radix-ui/react-dialog';
import { Toaster } from 'sonner';
import { useUIStore } from '@/state/ui-store';
import { useCaptureConnection, useCaptureSettingsSync } from '@/hooks/use-capture-connection';
import { useContainerWidth } from '@/hooks/use-container-width';
import { loadLayout, saveLayout } from '@/lib/layout-storage';
import { cn } from '@/lib/cn';
import { Toolbar } from './components/layout/toolbar';
import { StatusBar } from './components/layout/status-bar';
import { TokenList } from './components/sidebar/token-list';
import { TokenHeader } from './features/tokens/token-header';
import { DetailTabs } from './features/tokens/detail-tabs';
import { DetailContent } from './features/tokens/detail-content';
import { PayloadViewer } from './features/tokens/payload-viewer';
import { DiagnosticsPanel } from './features/diagnostics/diagnostics-panel';
import { RequestExplorer } from './features/requests/request-explorer';
import { GlobalTimeline } from './features/timeline/global-timeline';
import { DecoderWorkspace } from './features/decoder/decoder-workspace';

/** Below this width the three columns cannot all stay usable, so the panel switches to a single-column view. */
export const NARROW_LAYOUT_BREAKPOINT = 720;

function ResizeHandle({ label }: { label: string }) {
  return (
    <Separator
      aria-label={label}
      className="group relative w-px shrink-0 bg-dt-border transition-colors hover:bg-dt-accent data-[separator-active]:bg-dt-accent data-[separator-hover]:bg-dt-accent"
    >
      <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
    </Separator>
  );
}

function OverviewColumn() {
  return (
    <div className="flex h-full flex-col" data-testid="overview-tab">
      <TokenHeader />
      <DetailTabs />
      <div className="min-h-0 flex-1 overflow-hidden">
        <DetailContent />
      </div>
    </div>
  );
}

function RightPanel() {
  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="inspector-column">
      <div className="min-h-0 flex-1 overflow-hidden border-b border-dt-border">
        <PayloadViewer />
      </div>
      <div className="h-[45%] min-h-0 overflow-auto scrollbar-thin" tabIndex={0} aria-label="Diagnostics (scrollable)">
        <DiagnosticsPanel />
      </div>
    </div>
  );
}

function WideLayout() {
  const [defaultLayout] = useState<Layout | undefined>(() => loadLayout());
  const handleLayoutChanged = useCallback((layout: Layout, meta: { isUserInteraction: boolean; requestedLayout?: Layout }) => {
    if (meta.isUserInteraction) saveLayout(meta.requestedLayout ?? layout);
  }, []);

  return (
    <Group orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={handleLayoutChanged} className="h-full" id="tokenlens-layout">
      <Panel id="sidebar" defaultSize="22%" minSize={200} maxSize="40%" className="h-full">
        <div className="h-full overflow-hidden border-r border-dt-border bg-dt-bg-secondary">
          <TokenList />
        </div>
      </Panel>
      <ResizeHandle label="Resize token list" />
      <Panel id="main" defaultSize="48%" minSize={280} className="h-full">
        <div className="h-full overflow-hidden">
          <OverviewColumn />
        </div>
      </Panel>
      <ResizeHandle label="Resize inspector" />
      <Panel id="inspector" defaultSize="30%" minSize={220} maxSize="50%" className="h-full">
        <div className="h-full overflow-hidden border-l border-dt-border">
          <RightPanel />
        </div>
      </Panel>
    </Group>
  );
}

type NarrowView = 'tokens' | 'details' | 'inspector';

function NarrowLayout() {
  const [view, setView] = useState<NarrowView>('tokens');
  const views: { id: NarrowView; label: string }[] = [
    { id: 'tokens', label: 'Tokens' },
    { id: 'details', label: 'Details' },
    { id: 'inspector', label: 'Inspector' },
  ];
  return (
    <div className="flex h-full flex-col" data-testid="narrow-layout">
      <div role="tablist" aria-label="Panel sections" className="flex shrink-0 border-b border-dt-border bg-dt-bg-secondary">
        {views.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={cn(
              'flex-1 px-2 py-1.5 text-xs transition-colors',
              view === v.id ? 'border-b-2 border-dt-accent text-dt-text font-medium' : 'text-dt-text-secondary hover:text-dt-text'
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'tokens' && (
          <div className="h-full bg-dt-bg-secondary">
            <TokenList onTokenActivated={() => setView('details')} />
          </div>
        )}
        {view === 'details' && <OverviewColumn />}
        {view === 'inspector' && <RightPanel />}
      </div>
    </div>
  );
}

function PayloadDialog() {
  const maximized = useUIStore((s) => s.payloadMaximized);
  const setMaximized = useUIStore((s) => s.setPayloadMaximized);
  return (
    <Dialog.Root open={maximized} onOpenChange={setMaximized}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 animate-fade-in" />
        <Dialog.Content
          className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-lg border border-dt-border bg-dt-bg shadow-xl animate-fade-in focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Payload (maximized)</Dialog.Title>
          <PayloadViewer maximized />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Overview keeps the three-column workspace; Requests and Timeline are cross-token views and the
 * Decoder a manual-input workspace, all using the full width.
 */
function Workspace({ narrow }: { narrow: boolean }) {
  const activeMainTab = useUIStore((s) => s.activeMainTab);
  if (activeMainTab === 'requests') return <RequestExplorer />;
  if (activeMainTab === 'timeline') return <GlobalTimeline />;
  if (activeMainTab === 'decoder') return <DecoderWorkspace narrow={narrow} />;
  return narrow ? <NarrowLayout /> : <WideLayout />;
}

export function App() {
  const theme = useUIStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  const narrow = width > 0 && width < NARROW_LAYOUT_BREAKPOINT;

  useCaptureConnection();
  useCaptureSettingsSync();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
    root.dataset.theme = theme;
  }, [theme]);

  return (
    <div ref={containerRef} className="flex h-screen flex-col overflow-hidden bg-dt-bg text-dt-text" data-theme={theme}>
      <Toolbar />
      <div className="min-h-0 flex-1 overflow-hidden">
        <Workspace narrow={narrow} />
      </div>
      <StatusBar />
      <PayloadDialog />
      <Toaster
        position="bottom-right"
        offset={32}
        toastOptions={{
          style: {
            background: 'var(--dt-bg-elevated)',
            color: 'var(--dt-text)',
            border: '1px solid var(--dt-border)',
            fontSize: '12px',
          },
        }}
      />
    </div>
  );
}
