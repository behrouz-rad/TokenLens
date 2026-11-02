import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { useCaptureConnection } from '@/hooks/use-capture-connection';
import { isCaptureMessage, type CaptureMessage, type MessagePort } from '@/core/capture/channel';
import { useCaptureStore } from '@/state/capture-store';
import { clearCaptureWithFeedback } from '@/state/capture-actions';
import { useUIStore } from '@/state/ui-store';
import { createSyntheticJwt, withBearer } from '@/core/testing/synthetic';
import { resetStores } from './helpers';

function createFakePort() {
  const handlers = new Set<(message: CaptureMessage) => void>();
  const sent: CaptureMessage[] = [];
  let closed = 0;
  const port: MessagePort = {
    postMessage: (message) => void sent.push(message),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close: () => {
      closed += 1;
    },
  };
  return { port, sent, handlers, emit: (m: CaptureMessage) => handlers.forEach((h) => h(m)), get closed() { return closed; } };
}

const token = createSyntheticJwt({ alg: 'HS256' }, { sub: 'x' });

describe('useCaptureConnection', () => {
  beforeEach(() => resetStores());
  afterEach(() => resetStores());

  it('says hello, ingests snapshots and live batches, and tolerates StrictMode double mounting', () => {
    const fake = createFakePort();
    const createPort = () => fake.port;
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { unmount } = renderHook(() => useCaptureConnection({ createPort }), { wrapper });

    expect(fake.sent.filter((m) => m.type === 'hello').length).toBeGreaterThanOrEqual(1);
    expect(fake.handlers.size).toBe(1);

    const observations = [withBearer(token), withBearer(token)];
    act(() => fake.emit({ type: 'snapshot', from: 'relay', relayId: 'r', scope: 'standalone', observations }));
    act(() => fake.emit({ type: 'observations', from: 'relay', relayId: 'r', scope: 'standalone', observations }));
    expect(useCaptureStore.getState().session.requests.size).toBe(2);
    expect(useCaptureStore.getState().session.tokens.size).toBe(1);

    unmount();
    expect(fake.handlers.size).toBe(0);
    expect(fake.closed).toBeGreaterThanOrEqual(1);
  });

  it('asks the relay to drop its replay buffer when the session is cleared', () => {
    const fake = createFakePort();
    renderHook(() => useCaptureConnection({ createPort: () => fake.port }));
    act(() => fake.emit({ type: 'observations', from: 'relay', relayId: 'r', scope: 'standalone', observations: [withBearer(token)] }));
    act(() => clearCaptureWithFeedback());
    expect(fake.sent.filter((m) => m.type === 'clear')).toEqual([{ type: 'clear', from: 'panel', scope: 'standalone' }]);
    expect(useCaptureStore.getState().session.tokens.size).toBe(0);
  });

  it('honours the recording flag at ingestion time', () => {
    const fake = createFakePort();
    renderHook(() => useCaptureConnection({ createPort: () => fake.port }));
    useUIStore.getState().setRecording(false);
    act(() => fake.emit({ type: 'observations', from: 'relay', relayId: 'r', scope: 'standalone', observations: [withBearer(token)] }));
    expect(useCaptureStore.getState().session.tokens.size).toBe(0);
    expect(useCaptureStore.getState().session.counters.ignoredWhilePaused).toBe(1);
  });
});

describe('isCaptureMessage', () => {
  it('accepts well-formed messages and rejects everything else', () => {
    expect(isCaptureMessage({ type: 'hello', from: 'panel', scope: '1' })).toBe(true);
    expect(isCaptureMessage({ type: 'snapshot', from: 'relay', relayId: 'r', scope: '1', observations: [] })).toBe(true);
    expect(isCaptureMessage({ type: 'snapshot', from: 'panel', relayId: 'r', scope: '1', observations: [] })).toBe(false);
    expect(isCaptureMessage({ type: 'hello' })).toBe(false);
    expect(isCaptureMessage('hello')).toBe(false);
    expect(isCaptureMessage(null)).toBe(false);
  });
});
