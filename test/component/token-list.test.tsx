import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TokenList } from '@/devtools/panel/components/sidebar/token-list';
import { useCaptureStore } from '@/state/capture-store';
import { createSyntheticJwt, withBearer } from '@/core/testing/synthetic';
import { NOW, renderWithStores, resetStores, seconds, seed, standardScenario } from './helpers';

describe('TokenList', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    resetStores();
  });
  afterEach(() => {
    resetStores();
    vi.useRealTimers();
  });

  it('hides expired tokens by default and reveals them on demand', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<TokenList />);
    expect(screen.getAllByTestId('token-item')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: /Show expired \(1\)/ }));
    expect(screen.getAllByTestId('token-item')).toHaveLength(6);
    await user.click(screen.getByRole('button', { name: /Hide expired/ }));
    expect(screen.getAllByTestId('token-item')).toHaveLength(5);
  });

  it('shows expired tokens when the expired-only quick filter is active even if hidden', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<TokenList />);
    await user.click(screen.getByRole('button', { name: /Only expired/ }));
    const items = screen.getAllByTestId('token-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Expired');
    expect(screen.queryByRole('button', { name: /Show expired/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('token-list-heading')).toHaveTextContent('Tokens (1/6)');
  });

  it('computes failed-request and other quick filter counts from real data', () => {
    seed(standardScenario());
    renderWithStores(<TokenList />);
    expect(screen.getByTestId('quick-filter-count-failed-requests')).toHaveTextContent('3');
    expect(screen.getByTestId('quick-filter-count-only-expired')).toHaveTextContent('1');
    expect(screen.getByTestId('quick-filter-count-expiring-soon')).toHaveTextContent('1');
    expect(screen.getByTestId('quick-filter-count-invalid-tokens')).toHaveTextContent('1');
  });

  it('filters by search text and offers to clear filters when nothing matches', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<TokenList />);
    const search = screen.getByLabelText('Filter tokens');
    await user.type(search, 'legacy');
    expect(screen.getAllByTestId('token-item')).toHaveLength(1);
    await user.clear(search);
    await user.type(search, 'nothing-matches');
    expect(screen.queryAllByTestId('token-item')).toHaveLength(0);
    expect(screen.getByText('No tokens match the current filters')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(screen.getAllByTestId('token-item')).toHaveLength(5);
    expect(useCaptureStore.getState().filter.search).toBe('');
  });

  it('keeps the selection when the selected token is filtered out', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<TokenList />);
    const selected = useCaptureStore.getState().session.selectedTokenId;
    await user.type(screen.getByLabelText('Filter tokens'), 'legacy');
    expect(useCaptureStore.getState().session.selectedTokenId).toBe(selected);
  });

  it('supports arrow-key navigation through the visible list', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderWithStores(<TokenList />);
    const listbox = screen.getByRole('listbox');
    const visibleIds = screen.getAllByTestId('token-item').map((el) => el.dataset.tokenId);
    act(() => useCaptureStore.getState().select(visibleIds[0]!));
    listbox.focus();
    await user.keyboard('{ArrowDown}');
    expect(useCaptureStore.getState().session.selectedTokenId).toBe(visibleIds[1]);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(useCaptureStore.getState().session.selectedTokenId).toBe(visibleIds[0]);
  });

  it('updates badges when a token expires over time', () => {
    const soon = createSyntheticJwt({ alg: 'HS256' }, { sub: 'soon', exp: seconds(NOW) + 60 });
    seed([withBearer(soon, { url: 'https://api.example.test/x' })]);
    renderWithStores(<TokenList />);
    expect(screen.getByTestId('token-item')).toHaveTextContent('Expiring');
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.queryByTestId('token-item')).not.toBeInTheDocument();
    expect(screen.getByText(/1 expired token hidden/)).toBeInTheDocument();
    expect(screen.getByTestId('quick-filter-count-only-expired')).toHaveTextContent('1');
  });
});
