import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/devtools/panel/app';
import { useUIStore } from '@/state/ui-store';
import { useCaptureStore } from '@/state/capture-store';
import { DECODE_DEBOUNCE_MS, useDecoderStore } from '@/state/decoder-store';
import { verifyReferentialIntegrity } from '@/core/capture/session';
import { utf8ToBase64Url } from '@/core/jwt/base64url';
import { createSyntheticJwt, SYNTHETIC_SIGNATURE } from '@/core/testing/synthetic';
import { NOW, renderWithStores, resetStores, seconds, seed, standardScenario } from './helpers';

/** App mounts its own Toaster, so it is rendered without the helper's second one. */
const renderApp = () => render(<App />);

const DECODER_JWT = createSyntheticJwt(
  { alg: 'RS256', typ: 'at+jwt', kid: 'decoder-key' },
  { iss: 'https://issuer.decoder.test', sub: 'decoder-user', aud: ['api://one', 'api://two'], exp: seconds(NOW) + 3600, iat: seconds(NOW) - 60, scope: 'read', profile: { name: 'Zoë 🔐 東京', roles: ['admin', { scoped: ['x'] }] } }
);
const MALFORMED = 'eyJhbGciOiJSUzI1NiJ9.!!!.sig';
const OPAQUE = 'decoder-opaque-synthetic-0001';
const JWE = [utf8ToBase64Url('{"alg":"RSA-OAEP","enc":"A256GCM"}'), 'a2V5', 'aXY', 'Y2lwaGVydGV4dA', 'dGFn'].join('.');
const UNSIGNED = createSyntheticJwt({ alg: 'none' }, { sub: 'nobody', exp: seconds(NOW) + 3600 }, '');

type User = ReturnType<typeof userEvent.setup>;

async function openDecoder(user: User): Promise<void> {
  await user.click(within(screen.getByRole('navigation', { name: 'Main sections' })).getByRole('button', { name: 'Decoder' }));
}

const field = () => screen.getByRole('textbox', { name: 'Token input' });

function flushDebounce(): void {
  act(() => {
    vi.advanceTimersByTime(DECODE_DEBOUNCE_MS);
  });
}

async function pasteToken(user: User, text: string): Promise<void> {
  await user.click(field());
  await user.paste(text);
  flushDebounce();
}

function storageContents(): string {
  const dump = (storage: Storage) => Array.from({ length: storage.length }, (_, i) => `${storage.key(i)}=${storage.getItem(storage.key(i) ?? '')}`).join('\n');
  return `${dump(localStorage)}\n${dump(sessionStorage)}`;
}

describe('Decoder', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    resetStores();
    sessionStorage.clear();
  });

  afterEach(() => {
    resetStores();
    vi.useRealTimers();
  });

  it('is the fourth section, opens with no capture data, and shows the empty state', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    expect(useUIStore.getState().activeMainTab).toBe('overview');
    await openDecoder(user);
    expect(within(screen.getByRole('navigation', { name: 'Main sections' })).getByRole('button', { name: 'Decoder' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Paste a JWT to inspect its header and payload.')).toBeInTheDocument();
    expect(screen.getByText('Decoded locally. Signature not verified.')).toBeInTheDocument();
    expect(field()).toHaveValue('');
    expect(field()).toHaveAttribute('spellcheck', 'false');
    expect(screen.getByRole('button', { name: 'Copy token' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear input' })).toBeDisabled();
    expect(screen.queryByTestId('token-list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('contentinfo', { name: 'Decoder status' })).toBeInTheDocument();
    expect(screen.getByTestId('status-decoder-state')).toHaveTextContent('Waiting for input');
    expect(screen.queryByTestId('status-token-count')).not.toBeInTheDocument();
  });

  it('decodes a pasted JWT automatically after the debounce and shows header, payload, claims and diagnostics', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    await user.click(field());
    await user.paste(DECODER_JWT);
    expect(screen.getByTestId('decoder-output')).toHaveAttribute('data-stale', 'true');
    expect(screen.getByTestId('status-decoder-state')).toHaveTextContent('Decoding…');
    flushDebounce();

    expect(screen.getByTestId('decoder-output')).toHaveAttribute('data-stale', 'false');
    expect(screen.getByTestId('decoder-token-type')).toHaveTextContent('JWT (Access)');
    const facts = screen.getByTestId('decoder-facts');
    expect(facts).toHaveTextContent('RS256');
    expect(facts).toHaveTextContent('Signature present, not verified');
    expect(facts).toHaveTextContent('https://issuer.decoder.test');
    expect(facts).toHaveTextContent('api://one, api://two');
    expect(screen.getByTestId('decoder-summary')).toHaveTextContent('Active');
    expect(screen.getByTestId('decoder-expiry')).toHaveTextContent('Expires in 1h');
    expect(within(screen.getByTestId('decoded-header')).getByText('"decoder-key"')).toBeInTheDocument();
    const payload = screen.getByTestId('decoded-payload');
    expect(within(payload).getByText('"Zoë 🔐 東京"')).toBeInTheDocument();
    expect(within(payload).getByRole('button', { name: 'Collapse roles' })).toBeInTheDocument();
    expect(screen.getByTestId('claims-summary')).toHaveTextContent('decoder-user');
    const diagnostics = screen.getByTestId('decoder-diagnostics');
    expect(diagnostics).toHaveTextContent('Signature present, not verified');
    expect(diagnostics).toHaveTextContent('Not measured');
    expect(diagnostics).not.toHaveTextContent('HTTP');
    expect(screen.getByTestId('status-decoder-state')).toHaveTextContent('JWT decoded · signature not verified');
    expect(document.body.textContent).not.toMatch(/\bverified\b(?<!not verified)/);
    expect(screen.queryByText(/First observed|127\.0\.0\.1|#\d+/)).not.toBeInTheDocument();
  });

  it('accepts a Bearer prefix and surrounding whitespace while keeping the typed input', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    const typed = `  bearer ${DECODER_JWT}\n`;
    await pasteToken(user, typed);
    expect(field()).toHaveValue(typed);
    expect(screen.getByTestId('decoder-token-type')).toHaveTextContent('JWT (Access)');
    const hints = screen.getByTestId('decoder-hints');
    expect(hints).toHaveTextContent('The Bearer prefix was ignored.');
    expect(hints).toHaveTextContent('Leading and trailing whitespace was ignored.');

    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(await navigator.clipboard.readText()).toBe(DECODER_JWT);
    expect(await screen.findByText('Token copied (sensitive)')).toBeInTheDocument();
  });

  it.each([
    { name: 'malformed', input: MALFORMED, title: 'Malformed JWT', detail: /Payload segment/, state: 'Malformed JWT' },
    { name: 'opaque', input: OPAQUE, title: 'Opaque token', detail: /no header or payload to decode/, state: 'Opaque token, nothing to decode' },
    { name: 'JWE', input: JWE, title: 'Unsupported token', detail: /JWE \(encrypted JWT\).*does not decrypt/, state: 'Encrypted token, not decrypted' },
  ])('gives specific feedback for $name input and shows no decoded sections', async ({ input, title, detail, state }) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    await pasteToken(user, input);
    const feedback = screen.getByTestId('decoder-feedback');
    expect(within(feedback).getByRole('heading')).toHaveTextContent(title);
    expect(feedback).toHaveTextContent(detail);
    expect(screen.queryByTestId('decoded-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decoded-payload')).not.toBeInTheDocument();
    expect(screen.queryByTestId('claims-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-decoder-state')).toHaveTextContent(state);
    expect(document.body.textContent).not.toMatch(/(?<!not )decrypted/);
  });

  it('decodes an unsigned token but labels it unsigned', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    await pasteToken(user, UNSIGNED);
    expect(screen.getByTestId('decoder-facts')).toHaveTextContent('Unsigned');
    expect(screen.getByTestId('decoder-diagnostics')).toHaveTextContent('Unsigned (alg: none)');
  });

  it('points out whitespace and missing segments instead of repairing the token', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    const [header, payload] = DECODER_JWT.split('.');
    await pasteToken(user, `${header}.${payload}`);
    expect(screen.getByTestId('decoder-hints')).toHaveTextContent(/has 2 dot-separated segments/);

    await user.clear(field());
    await pasteToken(user, `${DECODER_JWT.slice(0, 40)}\n${DECODER_JWT.slice(40)}`);
    expect(screen.getByTestId('decoder-feedback')).toHaveTextContent('Malformed JWT');
    expect(screen.getByTestId('decoder-hints')).toHaveTextContent(/spaces or line breaks/);
  });

  it('reports input above the size limit without truncating it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    const huge = `eyJ${'a'.repeat(70 * 1024)}`;
    act(() => useDecoderStore.getState().setInput(huge));
    flushDebounce();
    expect(screen.getByTestId('decoder-feedback')).toHaveTextContent('Token too large');
    expect(screen.getByTestId('decoder-feedback')).toHaveTextContent(/up to 64\.0 KiB.*nothing was truncated/);
    expect((field() as HTMLTextAreaElement).value).toHaveLength(huge.length);
  });

  it('never shows a previous result as describing new input', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    await pasteToken(user, DECODER_JWT);
    expect(screen.getByTestId('decoder-token-type')).toBeInTheDocument();

    await user.clear(field());
    expect(screen.getByText('Paste a JWT to inspect its header and payload.')).toBeInTheDocument();
    await user.paste(MALFORMED);
    const result = screen.getByTestId('decoder-output');
    expect(result).toHaveAttribute('data-stale', 'true');
    expect(screen.queryByTestId('decoder-token-type')).not.toBeInTheDocument();
    flushDebounce();
    expect(screen.getByTestId('decoder-feedback')).toHaveTextContent('Malformed JWT');

    await user.clear(field());
    await pasteToken(user, DECODER_JWT);
    await user.type(field(), '!');
    expect(screen.getByTestId('decoder-result')).toHaveAttribute('inert');
    expect(screen.getByTestId('decoder-pending')).toHaveTextContent('Input changed, decoding…');
    expect(screen.getByRole('button', { name: 'Copy payload JSON' }).closest('[inert]')).not.toBeNull();
    flushDebounce();
    expect(screen.getByTestId('decoder-feedback')).toHaveTextContent('Malformed JWT');
  });

  it('clears only the decoder, cancelling a pending decode', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderApp();
    await openDecoder(user);
    await user.click(field());
    await user.paste(DECODER_JWT);
    await user.click(screen.getByRole('button', { name: 'Clear input' }));
    expect(field()).toHaveValue('');
    act(() => {
      vi.advanceTimersByTime(DECODE_DEBOUNCE_MS * 5);
    });
    expect(screen.getByText('Paste a JWT to inspect its header and payload.')).toBeInTheDocument();
    expect(useDecoderStore.getState().inspection.state).toBe('empty');
    expect(useCaptureStore.getState().session.tokens.size).toBe(6);
  });

  it('switches Pretty / Raw per section and copies exactly what is shown', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    const headerText = '{"alg":"HS256","typ":"JWT"}';
    const payloadText = '{"sub":"raw-user","big":12345678901234567890}';
    await pasteToken(user, `${utf8ToBase64Url(headerText)}.${utf8ToBase64Url(payloadText)}.${SYNTHETIC_SIGNATURE}`);

    const header = screen.getByTestId('decoded-header');
    await user.click(within(header).getByRole('button', { name: 'Copy header JSON' }));
    expect(await navigator.clipboard.readText()).toBe(JSON.stringify({ alg: 'HS256', typ: 'JWT' }, null, 2));
    expect(await screen.findByText('Header JSON copied')).toBeInTheDocument();

    const payload = screen.getByTestId('decoded-payload');
    await user.click(within(within(payload).getByRole('group', { name: 'Payload display mode' })).getByRole('button', { name: 'Raw' }));
    expect(payload).toHaveAttribute('data-view', 'raw');
    expect(header).toHaveAttribute('data-view', 'pretty');
    expect(screen.getByTestId('decoded-payload-raw')).toHaveTextContent(payloadText);
    await user.click(within(payload).getByRole('button', { name: 'Copy payload JSON' }));
    expect(await navigator.clipboard.readText()).toBe(payloadText);
    expect(await screen.findByText('Raw payload JSON copied')).toBeInTheDocument();
  });

  it('reports clipboard failures', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    document.execCommand = vi.fn(() => false);
    renderApp();
    await openDecoder(user);
    await pasteToken(user, DECODER_JWT);
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    const toast = await screen.findByText(/Clipboard is unavailable/);
    expect(toast.textContent).not.toContain(DECODER_JWT.slice(0, 12));
  });

  it('keeps input, result and display mode across section and theme switches', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    await pasteToken(user, DECODER_JWT);
    await user.click(within(screen.getByRole('group', { name: 'Header display mode' })).getByRole('button', { name: 'Raw' }));

    const nav = screen.getByRole('navigation', { name: 'Main sections' });
    for (const section of ['Overview', 'Requests', 'Timeline']) {
      await user.click(within(nav).getByRole('button', { name: section }));
      expect(screen.queryByTestId('decoder-workspace')).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    await openDecoder(user);
    expect(field()).toHaveValue(DECODER_JWT);
    expect(screen.getByTestId('decoded-header')).toHaveAttribute('data-view', 'raw');
    expect(screen.getByTestId('decoder-token-type')).toHaveTextContent('JWT (Access)');
  });

  it('leaves capture data, selection, filters, recording and counts untouched', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderApp();
    const tokens = [...useCaptureStore.getState().session.tokens.values()];
    act(() => {
      useCaptureStore.getState().select(tokens[2]!.id);
      useCaptureStore.getState().setSearch('example');
      useCaptureStore.getState().setRequestFilter({ statusCategory: '4xx' });
      useCaptureStore.getState().setTimelineFilter({ eventType: 'captured' });
    });
    const before = useCaptureStore.getState();

    await openDecoder(user);
    await pasteToken(user, `Bearer ${tokens[0]!.raw}`);
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await user.click(within(screen.getByRole('group', { name: 'Payload display mode' })).getByRole('button', { name: 'Raw' }));
    await user.click(screen.getByRole('button', { name: 'Clear input' }));
    await pasteToken(user, DECODER_JWT);

    const after = useCaptureStore.getState();
    expect(after.session).toBe(before.session);
    expect(after.filter).toBe(before.filter);
    expect(after.requestFilter).toBe(before.requestFilter);
    expect(after.timelineFilter).toBe(before.timelineFilter);
    expect(after.session.selectedTokenId).toBe(tokens[2]!.id);
    expect(useUIStore.getState().isRecording).toBe(true);
    expect(verifyReferentialIntegrity(after.session)).toEqual([]);

    await user.click(within(screen.getByRole('navigation', { name: 'Main sections' })).getByRole('button', { name: 'Overview' }));
    expect(screen.getByTestId('status-token-count')).toHaveTextContent('Captured 6 tokens');
    expect(screen.getByTestId('status-request-count')).toHaveTextContent('Requests with Bearer: 8');
  });

  it('keeps decoder input when the capture session is cleared, and capture keeps running while Decoder is open', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    seed(standardScenario());
    renderApp();
    await openDecoder(user);
    await pasteToken(user, DECODER_JWT);

    await user.click(screen.getByRole('button', { name: 'Clear captured tokens and requests' }));
    expect(useCaptureStore.getState().session.tokens.size).toBe(0);
    expect(field()).toHaveValue(DECODER_JWT);
    expect(screen.getByTestId('decoder-token-type')).toHaveTextContent('JWT (Access)');

    seed(standardScenario());
    expect(useCaptureStore.getState().session.tokens.size).toBe(6);
    expect(field()).toHaveValue(DECODER_JWT);
  });

  it('decodes while recording is paused without capturing anything', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await user.click(screen.getByRole('button', { name: /Recording/ }));
    await openDecoder(user);
    await pasteToken(user, DECODER_JWT);
    expect(screen.getByTestId('decoder-token-type')).toHaveTextContent('JWT (Access)');
    expect(useUIStore.getState().isRecording).toBe(false);
    expect(useCaptureStore.getState().session.tokens.size).toBe(0);
    expect(useCaptureStore.getState().session.counters.observedRequests).toBe(0);
  });

  it('keeps time-based results current while open', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    await pasteToken(user, createSyntheticJwt({ alg: 'HS256' }, { sub: 'short', exp: seconds(NOW) + 10, nbf: seconds(NOW) - 10 }));
    expect(screen.getByTestId('decoder-summary')).toHaveTextContent('Expiring');
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.getByTestId('decoder-summary')).toHaveTextContent('Expired');
    expect(screen.getByTestId('decoder-diagnostics')).toHaveTextContent(/Expired \d+ seconds? ago/);

    await user.clear(field());
    await pasteToken(user, createSyntheticJwt({ alg: 'HS256' }, { sub: 'later', nbf: seconds(Date.now()) + 3600 }));
    expect(screen.getByTestId('decoder-summary')).toHaveTextContent('Not yet active');
  });

  it('persists no credential or decoded claim anywhere', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    await openDecoder(user);
    await pasteToken(user, `Bearer ${DECODER_JWT}`);
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    const stored = storageContents();
    expect(stored).not.toContain(DECODER_JWT.slice(0, 20));
    expect(stored).not.toContain('decoder-user');
    expect(stored).toContain('"theme":"light"');
    expect(window.location.href).not.toContain(DECODER_JWT.slice(0, 20));
  });

  it('stacks input above output in the narrow layout', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { DecoderWorkspace } = await import('@/devtools/panel/features/decoder/decoder-workspace');
    renderWithStores(<DecoderWorkspace narrow />);
    expect(screen.getByTestId('decoder-workspace')).toHaveAttribute('data-layout', 'narrow');
    await pasteToken(user, DECODER_JWT);
    const workspace = screen.getByTestId('decoder-workspace');
    const order = [...workspace.querySelectorAll('[data-testid=decoder-input-panel], [data-testid=decoder-output]')].map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['decoder-input-panel', 'decoder-output']);
    expect(screen.getByRole('button', { name: 'Clear input' })).toBeEnabled();
  });
});
