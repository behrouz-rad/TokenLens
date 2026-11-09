import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECODE_DEBOUNCE_MS, isDecoderResultStale, resetDecoderStoreForTests, useDecoderStore } from '@/state/decoder-store';
import { resetCaptureStoreForTests, useCaptureStore } from '@/state/capture-store';
import { createSyntheticJwt, resetSyntheticSequence, withBearer } from '@/core/testing/synthetic';
import { verifyReferentialIntegrity } from '@/core/capture/session';

const JWT = createSyntheticJwt({ alg: 'HS256' }, { sub: 'decoder-user' });
const store = () => useDecoderStore.getState();

describe('decoder store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDecoderStoreForTests();
    resetCaptureStoreForTests();
    resetSyntheticSequence();
  });

  afterEach(() => {
    resetDecoderStoreForTests();
    vi.useRealTimers();
  });

  it('decodes after the debounce and marks the result stale until then', () => {
    store().setInput(JWT);
    expect(store().input).toBe(JWT);
    expect(store().inspection.state).toBe('empty');
    expect(isDecoderResultStale(store())).toBe(true);

    vi.advanceTimersByTime(DECODE_DEBOUNCE_MS - 1);
    expect(store().inspection.state).toBe('empty');
    vi.advanceTimersByTime(1);
    expect(store().inspection.state).toBe('analyzed');
    expect(isDecoderResultStale(store())).toBe(false);
  });

  it('restarts the debounce on every edit and only decodes the latest input', () => {
    store().setInput('first');
    vi.advanceTimersByTime(DECODE_DEBOUNCE_MS / 2);
    store().setInput(JWT);
    vi.advanceTimersByTime(DECODE_DEBOUNCE_MS / 2);
    expect(store().inspection.state).toBe('empty');
    vi.advanceTimersByTime(DECODE_DEBOUNCE_MS);
    const inspection = store().inspection;
    expect(inspection.state === 'analyzed' && inspection.credential).toBe(JWT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('marks a valid result stale as soon as the input is replaced with invalid input', () => {
    store().setInput(JWT);
    vi.runAllTimers();
    store().setInput('eyJhbGciOiJSUzI1NiJ9.!!!.sig');
    expect(isDecoderResultStale(store())).toBe(true);
    vi.runAllTimers();
    const inspection = store().inspection;
    expect(inspection.state === 'analyzed' && inspection.analysis.format).toBe('malformed-jwt');
    expect(isDecoderResultStale(store())).toBe(false);
  });

  it('shows the empty result immediately when the field is emptied', () => {
    store().setInput(JWT);
    vi.runAllTimers();
    store().setInput('   ');
    expect(store().inspection.state).toBe('empty');
    expect(isDecoderResultStale(store())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending debounce work when the input is cleared', () => {
    store().setInput(JWT);
    expect(vi.getTimerCount()).toBe(1);
    store().clearInput();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DECODE_DEBOUNCE_MS * 5);
    expect(store()).toMatchObject({ input: '', inspectedInput: '', inspection: { state: 'empty' } });
  });

  it('keeps the Pretty / Raw choice per section', () => {
    store().setView('payload', 'raw');
    expect(store().views).toEqual({ header: 'pretty', payload: 'raw' });
    store().clearInput();
    expect(store().views.payload).toBe('raw');
  });

  it('never touches the capture session, and clearing the capture leaves decoder input alone', () => {
    useCaptureStore.getState().ingest([withBearer(createSyntheticJwt({ alg: 'HS256' }, { sub: 'captured' }))], { recording: true, clearOnNavigation: false });
    const sessionBefore = useCaptureStore.getState().session;
    const filtersBefore = { filter: useCaptureStore.getState().filter, requestFilter: useCaptureStore.getState().requestFilter };

    store().setInput(`Bearer ${JWT}`);
    vi.runAllTimers();
    store().setView('header', 'raw');
    store().clearInput();
    store().setInput(JWT);
    vi.runAllTimers();

    expect(useCaptureStore.getState().session).toBe(sessionBefore);
    expect(useCaptureStore.getState().session.tokens.size).toBe(1);
    expect({ filter: useCaptureStore.getState().filter, requestFilter: useCaptureStore.getState().requestFilter }).toEqual(filtersBefore);
    expect(verifyReferentialIntegrity(useCaptureStore.getState().session)).toEqual([]);

    useCaptureStore.getState().clear();
    expect(store().input).toBe(JWT);
    expect(store().inspection.state).toBe('analyzed');
  });
});
