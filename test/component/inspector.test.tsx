import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PayloadViewer } from '@/devtools/panel/features/tokens/payload-viewer';
import { JsonViewer } from '@/devtools/panel/components/ui/json-viewer';
import { ClaimsSummary } from '@/devtools/panel/features/tokens/claims-summary';
import { DiagnosticsPanel } from '@/devtools/panel/features/diagnostics/diagnostics-panel';
import { TokenHeader } from '@/devtools/panel/features/tokens/token-header';
import { RequestTable } from '@/devtools/panel/features/requests/request-table';
import { TokenTimeline } from '@/devtools/panel/features/timeline/token-timeline';
import { useCaptureStore } from '@/state/capture-store';
import { createSyntheticJwt, withBearer } from '@/core/testing/synthetic';
import { FIXTURE, NOW, renderWithStores, resetStores, seconds, seed, standardScenario } from './helpers';

function selectTokenByRaw(raw: string): void {
  const token = [...useCaptureStore.getState().session.tokens.values()].find((t) => t.raw === raw);
  if (!token) throw new Error('token not seeded');
  useCaptureStore.getState().select(token.id);
}

describe('inspector components', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    resetStores();
  });
  afterEach(() => {
    resetStores();
    vi.useRealTimers();
  });

  describe('PayloadViewer', () => {
    it('switches between pretty and raw, expands all, and copies with feedback', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      seed(standardScenario());
      selectTokenByRaw(FIXTURE.access);
      renderWithStores(<PayloadViewer />);

      expect(screen.getByTestId('json-viewer')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Collapse org' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Expand tags' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Expand all' }));
      expect(screen.getByRole('button', { name: 'Collapse tags' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Copy payload JSON' }));
      const copiedJson = await navigator.clipboard.readText();
      expect(copiedJson).toContain('"sub": "user-1"');
      expect(copiedJson).not.toContain(FIXTURE.access);
      expect(await screen.findByText('Payload JSON copied')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Raw' }));
      expect(screen.getByTestId('payload-raw')).toHaveTextContent(FIXTURE.access);
      await user.click(screen.getByRole('button', { name: 'Copy raw token' }));
      expect(await navigator.clipboard.readText()).toBe(FIXTURE.access);
    });

    it('reports clipboard failures instead of pretending success', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
      const execCommand = vi.fn(() => false);
      document.execCommand = execCommand;
      seed(standardScenario());
      selectTokenByRaw(FIXTURE.access);
      renderWithStores(<PayloadViewer />);
      await user.click(screen.getByRole('button', { name: 'Copy payload JSON' }));
      expect(writeText).toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(await screen.findByText(/Clipboard is unavailable/)).toBeInTheDocument();
    });

    it('shows the raw value for opaque tokens and disables pretty mode', () => {
      seed(standardScenario());
      selectTokenByRaw(FIXTURE.opaque);
      renderWithStores(<PayloadViewer />);
      expect(screen.getByText(/Opaque Bearer token: no decodable payload/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Pretty' })).toBeDisabled();
    });
  });

  describe('JsonViewer', () => {
    it('expands and collapses nested nodes and renders unicode strings', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithStores(<JsonViewer data={{ a: { b: { c: [1, 'Zoë 🔐', null, true] } } }} expandDepth={1} />);
      expect(screen.getByText(/…1 key/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Expand a' }));
      await user.click(screen.getByRole('button', { name: 'Expand b' }));
      await user.click(screen.getByRole('button', { name: 'Expand c' }));
      expect(screen.getByText('"Zoë 🔐"')).toBeInTheDocument();
      expect(screen.getByText('null')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Collapse a' }));
      expect(screen.queryByText('"Zoë 🔐"')).not.toBeInTheDocument();
    });

    it('caps rendering depth for hostile nesting without crashing', () => {
      let nested: unknown = 'leaf';
      for (let i = 0; i < 200; i++) nested = { n: nested };
      renderWithStores(<JsonViewer data={nested} expandDepth={Number.POSITIVE_INFINITY} />);
      expect(screen.getByText(/nesting too deep/)).toBeInTheDocument();
    });

    it('never interprets claim values as markup', () => {
      renderWithStores(<JsonViewer data={{ xss: '<img src=x onerror=alert(1)>' }} />);
      expect(document.querySelector('img')).toBeNull();
      expect(screen.getByText('"<img src=x onerror=alert(1)>"')).toBeInTheDocument();
    });
  });

  describe('ClaimsSummary', () => {
    it('lists standard claims and expands to all claims', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      seed(standardScenario());
      selectTokenByRaw(FIXTURE.access);
      renderWithStores(<ClaimsSummary />);
      expect(screen.getByText('iss')).toBeInTheDocument();
      expect(screen.queryByText('org')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Show all 7 claims/ }));
      expect(screen.getByText('org')).toBeInTheDocument();
      expect(screen.getByText('{"id":"o-1","tags":["a","b"]}')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Show standard claims only/ }));
      expect(screen.queryByText('org')).not.toBeInTheDocument();
    });

    it('renders invalid date claims without crashing', () => {
      const broken = createSyntheticJwt({ alg: 'HS256' }, { exp: 'later', iat: 1e15 });
      seed([withBearer(broken)]);
      renderWithStores(<ClaimsSummary />);
      expect(screen.getByText(/exp must be a NumericDate/)).toBeInTheDocument();
      expect(screen.getByText(/looks like milliseconds/)).toBeInTheDocument();
    });
  });

  describe('DiagnosticsPanel', () => {
    it('shows honest signature, algorithm and clock-skew states plus HTTP evidence', () => {
      seed(standardScenario());
      selectTokenByRaw(FIXTURE.access);
      renderWithStores(<DiagnosticsPanel />);
      const panel = screen.getByTestId('diagnostics-panel');
      expect(within(panel).getByText('Signature present — not verified')).toBeInTheDocument();
      expect(within(panel).getByText('Not measured')).toBeInTheDocument();
      expect(within(panel).getByText('RS256 (asymmetric)')).toBeInTheDocument();
      expect(within(panel).getByText('kid-1')).toBeInTheDocument();
      expect(within(panel).queryByText(/keys available/)).not.toBeInTheDocument();
      expect(within(panel).getByText('1 request forbidden')).toBeInTheDocument();
      expect(within(panel).getByText(/Possible causes|lacks a required scope/)).toBeInTheDocument();
    });

    it('updates expiration diagnostics as time passes', () => {
      const soon = createSyntheticJwt({ alg: 'HS256' }, { exp: seconds(NOW) + 30 });
      seed([withBearer(soon)]);
      renderWithStores(<DiagnosticsPanel />);
      expect(screen.getByText(/Expires in 30 seconds/)).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(31_000);
      });
      expect(screen.getByText(/Expired 1 second ago/)).toBeInTheDocument();
    });
  });

  describe('TokenHeader', () => {
    it('shows a truncated preview, copies the full header intentionally, and labels the signature state', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      seed(standardScenario());
      selectTokenByRaw(FIXTURE.access);
      renderWithStores(<TokenHeader />);
      expect(screen.getByTestId('token-header-preview')).toHaveTextContent('Bearer eyJhbGciOiJSUzI1…');
      expect(screen.getByTestId('token-header-preview').textContent).not.toContain(FIXTURE.access);
      expect(screen.getByText('Signature present — not verified')).toBeInTheDocument();
      expect(screen.getByText('JWT (Access)')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Copy Bearer token' }));
      expect(await navigator.clipboard.readText()).toBe(`Bearer ${FIXTURE.access}`);
      expect(await screen.findByText('Authorization header copied to clipboard')).toBeInTheDocument();
    });

    it('counts down the expiry label', () => {
      const soon = createSyntheticJwt({ alg: 'HS256' }, { exp: seconds(NOW) + 90 });
      seed([withBearer(soon)]);
      renderWithStores(<TokenHeader />);
      expect(screen.getByTestId('token-header-expiry')).toHaveTextContent('Expires in 1m');
      act(() => {
        vi.advanceTimersByTime(45_000);
      });
      expect(screen.getByTestId('token-header-expiry')).toHaveTextContent('Expires in 45s');
    });
  });

  describe('RequestTable and TokenTimeline', () => {
    it('lists correlated requests with correct status tones and sorts on header click', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      seed(standardScenario());
      selectTokenByRaw(FIXTURE.access);
      renderWithStores(<RequestTable />);
      expect(screen.getByText('Used in requests (3)')).toBeInTheDocument();
      const rows = screen.getAllByTestId('request-row');
      expect(rows.map((r) => r.dataset.status)).toEqual(['403', '201', '200']);
      await user.click(screen.getByRole('button', { name: /Status/ }));
      expect(screen.getAllByTestId('request-row').map((r) => r.dataset.status)).toEqual(['200', '201', '403']);
    });

    it('expands to show all requests when there are many', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      seed(Array.from({ length: 12 }, (_, i) => withBearer(FIXTURE.access, { url: `https://api.example.test/r/${i}` })));
      renderWithStores(<RequestTable />);
      const toggle = screen.getByRole('button', { name: /Show all 12 requests/ });
      await user.click(toggle);
      expect(screen.getByRole('button', { name: /Show fewer/ })).toBeInTheDocument();
    });

    it('shows timeline events for the selected token only', () => {
      seed(standardScenario());
      selectTokenByRaw(FIXTURE.access);
      renderWithStores(<TokenTimeline />);
      const events = screen.getAllByTestId('timeline-event');
      const types = events.map((e) => e.dataset.eventType);
      expect(types).toContain('captured');
      expect(types).toContain('issued');
      expect(types.filter((t) => t === 'used-in-request')).toHaveLength(2);
      expect(types.filter((t) => t === 'failed-request')).toHaveLength(1);
      expect(screen.getByText('5 events')).toBeInTheDocument();
    });
  });
});
