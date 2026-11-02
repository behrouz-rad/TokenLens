import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/devtools/panel/app';
import { RequestExplorer } from '@/devtools/panel/features/requests/request-explorer';
import { GlobalTimeline } from '@/devtools/panel/features/timeline/global-timeline';
import { useCaptureStore } from '@/state/capture-store';
import { useUIStore } from '@/state/ui-store';
import { createSyntheticJwt, withBearer } from '@/core/testing/synthetic';
import { FIXTURE, NOW, renderWithStores, resetStores, seconds, seed, standardScenario } from './helpers';

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const tokenByRaw = (raw: string) => [...useCaptureStore.getState().session.tokens.values()].find((t) => t.raw === raw)!;
const rowStatuses = () => screen.getAllByTestId('request-row').map((r) => r.dataset.status);

describe('RequestExplorer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    resetStores();
  });
  afterEach(() => {
    resetStores();
    vi.useRealTimers();
  });

  it('shows an empty state before anything is captured', () => {
    renderWithStores(<RequestExplorer />);
    expect(screen.getByText('No requests captured yet')).toBeInTheDocument();
    expect(screen.queryAllByTestId('request-row')).toHaveLength(0);
  });

  it('lists every captured request across tokens, newest first, with host, status and token reference', () => {
    seed(standardScenario());
    renderWithStores(<RequestExplorer />);
    expect(screen.getByTestId('requests-heading')).toHaveTextContent('Requests (8)');
    expect(rowStatuses()).toEqual(['500', '200', '200', '401', '200', '403', '201', '200']);
    const rows = screen.getAllByTestId('request-row');
    expect(rows[0]).toHaveTextContent('api.example.test');
    expect(rows[0]).toHaveTextContent('/broken');
    expect(rows[0]).toHaveTextContent('malformed_token');
    expect(within(rows[0]!).getByRole('button', { name: /Show malformed_token #\d+ in Overview/ })).toBeInTheDocument();
  });

  it('searches by URL, host, method and token and offers to clear when nothing matches', async () => {
    const u = user();
    seed(standardScenario());
    renderWithStores(<RequestExplorer />);
    const search = screen.getByRole('searchbox', { name: 'Search requests' });
    await u.type(search, 'orders');
    expect(rowStatuses()).toEqual(['201']);
    await u.clear(search);
    await u.type(search, 'old.example.test');
    expect(rowStatuses()).toEqual(['401']);
    await u.clear(search);
    await u.type(search, 'POST');
    expect(rowStatuses()).toEqual(['201']);
    await u.clear(search);
    await u.type(search, 'access_token');
    expect(rowStatuses()).toEqual(['403', '201', '200']);
    expect(screen.getByTestId('requests-heading')).toHaveTextContent('Requests (3 of 8)');
    await u.clear(search);
    await u.type(search, 'nothing-here');
    expect(screen.getByText('No requests match the current filters')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Show all requests' }));
    expect(rowStatuses()).toHaveLength(8);
  });

  it('filters by HTTP status category and by token, and combines both', async () => {
    const u = user();
    seed(standardScenario());
    renderWithStores(<RequestExplorer />);
    const group = screen.getByRole('group', { name: 'Filter by HTTP status' });
    await u.click(within(group).getByRole('button', { name: /^4xx/ }));
    expect(rowStatuses()).toEqual(['401', '403']);
    expect(within(group).getByRole('button', { name: /^4xx/ })).toHaveAttribute('aria-pressed', 'true');

    const access = tokenByRaw(FIXTURE.access);
    await u.selectOptions(screen.getByRole('combobox', { name: 'Filter by token' }), access.id);
    expect(rowStatuses()).toEqual(['403']);
    await u.click(within(group).getByRole('button', { name: /^All/ }));
    expect(rowStatuses()).toEqual(['403', '201', '200']);
    await u.click(within(group).getByRole('button', { name: /^5xx/ }));
    expect(screen.getByText('No requests match the current filters')).toBeInTheDocument();
  });

  it('sorts by status, duration and time from the column headers', async () => {
    const u = user();
    seed(standardScenario());
    renderWithStores(<RequestExplorer />);
    await u.click(screen.getByRole('button', { name: /Status/ }));
    expect(rowStatuses()).toEqual(['200', '200', '200', '200', '201', '401', '403', '500']);
    await u.click(screen.getByRole('button', { name: /Status/ }));
    expect(rowStatuses()[0]).toBe('500');
    await u.click(screen.getByRole('button', { name: /Time/ }));
    expect(rowStatuses()).toEqual(['200', '201', '403', '200', '401', '200', '200', '500']);
  });

  it('navigates from a request to its token in the Overview', async () => {
    const u = user();
    seed(standardScenario());
    useUIStore.getState().setMainTab('requests');
    renderWithStores(<App />);
    expect(screen.getByTestId('requests-explorer')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /Show bearer_token #\d+ in Overview/ }));
    expect(useUIStore.getState().activeMainTab).toBe('overview');
    expect(screen.getByTestId('token-header-name')).toHaveTextContent('bearer_token');
    expect(useCaptureStore.getState().session.selectedTokenId).toBe(tokenByRaw(FIXTURE.opaque).id);
  });

  it('keeps counts consistent while paused, after clearing, and after eviction', async () => {
    const u = user();
    seed(standardScenario());
    renderWithStores(<RequestExplorer />);
    expect(screen.getByTestId('requests-heading')).toHaveTextContent('Requests (8)');

    seed([withBearer(FIXTURE.access, { url: 'https://api.example.test/paused' })], { recording: false, clearOnNavigation: false });
    expect(screen.getByTestId('requests-heading')).toHaveTextContent('Requests (8)');

    // The selected token is protected from eviction, so filter on a different one.
    const access = tokenByRaw(FIXTURE.expired);
    await u.selectOptions(screen.getByRole('combobox', { name: 'Filter by token' }), access.id);
    expect(rowStatuses()).toEqual(['401']);
    act(() => useCaptureStore.getState().updateSettings({ limits: { maxTokens: 10, maxRequests: 100 } }));
    act(() => {
      const many = Array.from({ length: 20 }, (_, i) => withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: `e-${i}`, exp: seconds(NOW) + 3600 }), { url: `https://x.example.test/${i}`, startedAt: NOW + i }));
      useCaptureStore.getState().ingest(many, { recording: true, clearOnNavigation: false });
    });
    expect(useCaptureStore.getState().session.tokens.has(access.id)).toBe(false);
    expect(screen.getByText('The filtered token is no longer in the session')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Show all requests' }));
    expect(screen.getAllByTestId('request-row').length).toBeGreaterThan(0);

    act(() => useCaptureStore.getState().clear());
    expect(screen.getByText('No requests captured yet')).toBeInTheDocument();
    expect(useCaptureStore.getState().requestFilter.tokenId).toBeNull();
  });

  it('virtualises large lists', () => {
    const token = createSyntheticJwt({ alg: 'HS256' }, { sub: 'bulk', exp: seconds(NOW) + 3600 });
    seed(Array.from({ length: 3000 }, (_, i) => withBearer(token, { url: `https://api.example.test/bulk/${i}`, startedAt: NOW + i })));
    renderWithStores(<RequestExplorer />);
    expect(screen.getByTestId('requests-heading')).toHaveTextContent('Requests (3000)');
    const rendered = screen.getAllByTestId('request-row').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(3000);
  });
});

describe('GlobalTimeline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    resetStores();
  });
  afterEach(() => {
    resetStores();
    vi.useRealTimers();
  });

  const eventTypes = () => screen.getAllByTestId('global-timeline-event').map((e) => e.dataset.eventType);

  it('shows an empty state before anything is captured', () => {
    renderWithStores(<GlobalTimeline />);
    expect(screen.getByText('No events yet')).toBeInTheDocument();
  });

  it('lists events from every token newest first and labels observed versus claim-derived events', () => {
    seed(standardScenario());
    renderWithStores(<GlobalTimeline />);
    const total = [...useCaptureStore.getState().session.eventsByToken.values()].reduce((n, e) => n + e.length, 0);
    expect(screen.getByTestId('timeline-heading')).toHaveTextContent(`Timeline (${total} events)`);
    const events = screen.getAllByTestId('global-timeline-event');
    expect(events).toHaveLength(total);
    const times = events.map((e) => new Date(e.querySelector('time')!.getAttribute('datetime')!).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i - 1]!).toBeGreaterThanOrEqual(times[i]!);
    const issued = events.find((e) => e.dataset.eventType === 'issued')!;
    expect(issued.dataset.basis).toBe('claim');
    expect(issued).toHaveTextContent('Issued (iat claim)');
    expect(issued).toHaveTextContent('claim');
    const captured = events.find((e) => e.dataset.eventType === 'captured')!;
    expect(captured.dataset.basis).toBe('observed');
    expect(captured).toHaveTextContent('First observed');
    expect(screen.queryByText(/refresh/i)).not.toBeInTheDocument();
  });

  it('filters by event type and token', async () => {
    const u = user();
    seed(standardScenario());
    renderWithStores(<GlobalTimeline />);
    const group = screen.getByRole('group', { name: 'Filter by event type' });
    await u.click(within(group).getByRole('button', { name: /^Failed request/ }));
    expect(new Set(eventTypes())).toEqual(new Set(['failed-request']));
    expect(eventTypes()).toHaveLength(3);
    const access = tokenByRaw(FIXTURE.access);
    await u.selectOptions(screen.getByRole('combobox', { name: 'Filter by token' }), access.id);
    expect(eventTypes()).toEqual(['failed-request']);
    await u.click(within(group).getByRole('button', { name: /^All/ }));
    expect(eventTypes()).toEqual(['failed-request', 'used-in-request', 'used-in-request', 'captured', 'issued']);
    await u.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(useCaptureStore.getState().timelineFilter).toEqual({ tokenId: null, eventType: null });
  });

  it('navigates to the token in Overview and to the request in the Requests explorer', async () => {
    const u = user();
    seed(standardScenario());
    useUIStore.getState().setMainTab('timeline');
    renderWithStores(<App />);
    const failed = screen.getAllByTestId('global-timeline-event').find((e) => e.dataset.eventType === 'failed-request' && e.textContent?.includes('/profile'))!;
    await u.click(within(failed).getByRole('button', { name: /Show request/ }));
    expect(useUIStore.getState().activeMainTab).toBe('requests');
    const focused = screen.getByTestId('requests-explorer').querySelector('[data-focused]');
    expect(focused).not.toBeNull();
    expect(focused).toHaveTextContent('/profile');

    await u.click(within(screen.getByRole('navigation', { name: 'Main sections' })).getByRole('button', { name: 'Timeline' }));
    const captured = screen.getAllByTestId('global-timeline-event').find((e) => e.dataset.eventType === 'captured' && e.textContent?.includes('jwt_token'))!;
    await u.click(within(captured).getByRole('button', { name: /Show jwt_token #\d+ in Overview/ }));
    expect(useUIStore.getState().activeMainTab).toBe('overview');
    expect(screen.getByTestId('token-header-name')).toHaveTextContent('jwt_token');
  });

  it('adds an expiry transition event when a token expires and reflects clearing', () => {
    seed([withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: 'soon', exp: seconds(NOW) + 30 }), { url: 'https://api.example.test/x' })]);
    renderWithStores(<GlobalTimeline />);
    expect(eventTypes()).toEqual(['used-in-request', 'captured']);
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(eventTypes()).toEqual(['expired', 'used-in-request', 'captured']);
    act(() => useCaptureStore.getState().clear());
    expect(screen.getByText('No events yet')).toBeInTheDocument();
  });

  it('virtualises large event lists', () => {
    const token = createSyntheticJwt({ alg: 'HS256' }, { sub: 'bulk', exp: seconds(NOW) + 3600 });
    seed(Array.from({ length: 800 }, (_, i) => withBearer(token, { url: `https://api.example.test/bulk/${i}`, startedAt: NOW + i })));
    renderWithStores(<GlobalTimeline />);
    expect(screen.getByTestId('timeline-heading')).toHaveTextContent('Timeline (801 events)');
    const rendered = screen.getAllByTestId('global-timeline-event').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(801);
  });
});
