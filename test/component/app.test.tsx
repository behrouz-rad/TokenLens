import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/devtools/panel/app';
import { useUIStore, PREFERENCES_STORAGE_KEY } from '@/state/ui-store';
import { useCaptureStore } from '@/state/capture-store';
import { NOW, renderWithStores, resetStores, seed, standardScenario } from './helpers';
import manifest from '../../manifest.json';

describe('App', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    resetStores();
  });

  afterEach(() => {
    resetStores();
    vi.useRealTimers();
  });

  it('renders the TokenLens branding, dark theme by default, and an informative empty state', () => {
    renderWithStores(<App />);
    expect(screen.getByText('TokenLens')).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(screen.getByText('No tokens captured yet')).toBeInTheDocument();
    expect(screen.getByText(/Authorization: Bearer header/)).toBeInTheDocument();
    expect(screen.getByTestId('status-token-count')).toHaveTextContent('Captured 0 tokens');
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing all data');
  });

  it('shows captured tokens, selects the first automatically, and switches selection on click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<App />);

    const items = screen.getAllByTestId('token-item');
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByTestId('token-header-name')).toHaveTextContent('access_token');
    expect(screen.getByTestId('status-token-count')).toHaveTextContent('Captured 6 tokens');
    expect(screen.getByTestId('status-request-count')).toHaveTextContent('Requests with Bearer: 8');
    expect(screen.getByTestId('status-http-breakdown')).toHaveTextContent('2xx: 5');
    expect(screen.getByTestId('status-http-breakdown')).toHaveTextContent('4xx: 2');
    expect(screen.getByTestId('status-http-breakdown')).toHaveTextContent('5xx: 1');

    const opaqueItem = items.find((el) => el.textContent?.includes('bearer_token'));
    expect(opaqueItem).toBeDefined();
    await user.click(opaqueItem!);
    expect(screen.getByTestId('token-header-name')).toHaveTextContent('bearer_token');
    expect(screen.getByTestId('non-jwt-notice')).toHaveTextContent('Bearer (opaque)');
    expect(screen.getByTestId('payload-raw')).toHaveTextContent('opaque-synthetic-token-0001');
  });

  it('toggles the theme, applies it to the document and persists the preference', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithStores(<App />);
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}')).toMatchObject({ theme: 'light' });
    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('offers only functional top-level sections and keeps capture data while switching between them', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main sections' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Overview', 'Requests', 'Timeline']);
    expect(screen.queryByText(/Coming soon/)).not.toBeInTheDocument();

    await user.click(within(nav).getByRole('button', { name: 'Requests' }));
    expect(screen.getByTestId('requests-explorer')).toBeInTheDocument();
    expect(screen.getByTestId('requests-heading')).toHaveTextContent('Requests (8)');
    expect(within(nav).getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-current', 'page');

    await user.click(within(nav).getByRole('button', { name: 'Timeline' }));
    expect(screen.getByTestId('global-timeline')).toBeInTheDocument();

    await user.click(within(nav).getByRole('button', { name: 'Overview' }));
    expect(screen.getByTestId('token-header-name')).toHaveTextContent('access_token');
    expect(screen.getByTestId('status-token-count')).toHaveTextContent('Captured 6 tokens');
  });

  it('shows the manifest version in the toolbar', () => {
    renderWithStores(<App />);
    expect(screen.getByTestId('app-version')).toHaveTextContent(`v${manifest.version}`);
  });

  it('pauses and resumes recording and reflects it in the status bar', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithStores(<App />);
    await user.click(screen.getByRole('button', { name: /Recording/ }));
    expect(useUIStore.getState().isRecording).toBe(false);
    expect(screen.getByTestId('status-paused')).toHaveTextContent('Paused');
    seed(standardScenario(), { recording: false, clearOnNavigation: false });
    expect(screen.getByTestId('status-token-count')).toHaveTextContent('Captured 0 tokens');
    expect(screen.getByTestId('status-paused')).toHaveTextContent('8 skipped');
    await user.click(screen.getByRole('button', { name: /Paused/ }));
    expect(useUIStore.getState().isRecording).toBe(true);
  });

  it('clears everything from the toolbar and status bar actions', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<App />);
    await user.click(screen.getByRole('button', { name: 'Clear captured tokens and requests' }));
    expect(useCaptureStore.getState().session.tokens.size).toBe(0);
    expect(screen.getByText('No tokens captured yet')).toBeInTheDocument();
    expect(screen.queryByTestId('token-header')).not.toBeInTheDocument();
  });

  it('opens the filters popover, applies the expired filter, and shows accurate counts', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<App />);
    expect(screen.getByText(/Show expired \(1\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const popover = await screen.findByTestId('filters-popover');
    await user.click(within(popover).getByRole('button', { name: /^Expired/ }));
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing 1 of 6 tokens');
    const items = screen.getAllByTestId('token-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Expired');
    expect(within(popover).getByText('Showing 1 of 6 tokens')).toBeInTheDocument();

    await user.click(within(popover).getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing all data');
  });

  it('scopes the toolbar Filters control to the Overview and lets the status bar describe the active section', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main sections' });

    // Overview: the token filter narrows the token list and is reported as such.
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(within(await screen.findByTestId('filters-popover')).getByRole('button', { name: /^Expired/ }));
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing 1 of 6 tokens');
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveTextContent('1');

    // Requests: the token filter has no effect here, so the control is absent and the summary is about requests.
    await user.click(within(nav).getByRole('button', { name: 'Requests' }));
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.getByTestId('requests-heading')).toHaveTextContent('Requests (8)');
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing all data');
    await user.click(within(screen.getByRole('group', { name: 'Filter by HTTP status' })).getByRole('button', { name: /^4xx/ }));
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing 2 of 8 requests');

    // Timeline: likewise, with its own filter and count.
    await user.click(within(nav).getByRole('button', { name: 'Timeline' }));
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing all data');
    await user.click(within(screen.getByRole('group', { name: 'Filter by event type' })).getByRole('button', { name: /^Failed request/ }));
    const total = [...useCaptureStore.getState().session.eventsByToken.values()].reduce((n, e) => n + e.length, 0);
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent(`Showing 3 of ${total} events`);

    // Back in the Overview the token filter is still active and still reported; each section keeps its own filter.
    await user.click(within(nav).getByRole('button', { name: 'Overview' }));
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing 1 of 6 tokens');
    expect(screen.getAllByTestId('token-item')).toHaveLength(1);
    expect(useCaptureStore.getState().requestFilter.statusCategory).toBe('4xx');
    expect(useCaptureStore.getState().timelineFilter.eventType).toBe('failed-request');

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(within(await screen.findByTestId('filters-popover')).getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('status-filter-summary')).toHaveTextContent('Showing all data');
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('changes settings through the settings popover and persists them', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithStores(<App />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const popover = await screen.findByTestId('settings-popover');
    await user.selectOptions(within(popover).getByLabelText('Expiring-soon threshold'), '15');
    await user.click(within(popover).getByLabelText(/Clear captured data when the page navigates/));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}')).toMatchObject({ expiringThresholdMs: 900_000, clearOnNavigation: true });
    });
    expect(useCaptureStore.getState().session.expiringThresholdMs).toBe(900_000);
  });

  it('maximizes and restores the payload viewer', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<App />);
    await user.click(screen.getByRole('button', { name: 'Maximize payload panel' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('json-viewer')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Restore payload panel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
