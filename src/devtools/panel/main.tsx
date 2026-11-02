import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import '@/styles/theme.css';

function isStandalone(): boolean {
  return typeof chrome === 'undefined' || chrome.devtools?.inspectedWindow == null;
}

/**
 * Outside DevTools (the Vite dev server) the panel has no relay to talk to, so development
 * builds seed the store with synthetic traffic. Production builds never do this: a production
 * panel opened outside DevTools shows the real empty state.
 */
async function seedDevelopmentData(): Promise<void> {
  if (!import.meta.env.DEV || !isStandalone()) return;
  if (new URLSearchParams(window.location.search).get('mock') === '0') return;
  const [{ createMockObservations }, { useCaptureStore }] = await Promise.all([
    import('@/core/mock-data'),
    import('@/state/capture-store'),
  ]);
  useCaptureStore.getState().ingest(createMockObservations(), { recording: true, clearOnNavigation: false });
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

void seedDevelopmentData().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
