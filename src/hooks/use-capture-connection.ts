import { useEffect } from 'react';
import { createBroadcastPort, resolveCaptureScope, type MessagePort } from '@/core/capture/channel';
import { useCaptureStore } from '@/state/capture-store';
import { useUIStore } from '@/state/ui-store';

export interface CaptureConnectionOptions {
  createPort?: (scope: string) => MessagePort;
}

let activeConnection: { port: MessagePort; scope: string } | null = null;

/**
 * Tells the relay to drop its replay buffer. Without this, a panel re-created by DevTools (for
 * example after the inspected page reloads) would replay records the user had already cleared.
 */
export function notifyRelayCleared(): void {
  activeConnection?.port.postMessage({ type: 'clear', from: 'panel', scope: activeConnection.scope });
}

/**
 * Connects the panel to the capture relay running in the DevTools page. On mount the panel
 * announces itself and receives a replay of everything the relay buffered; the store's
 * per-relay cursor makes that replay idempotent, so React StrictMode double-mounting and
 * development reloads cannot duplicate records.
 */
export function useCaptureConnection(options: CaptureConnectionOptions = {}): void {
  const createPort = options.createPort ?? createBroadcastPort;

  useEffect(() => {
    const scope = resolveCaptureScope();
    const port = createPort(scope);
    const unsubscribe = port.onMessage((message) => {
      if (message.type !== 'snapshot' && message.type !== 'observations') return;
      const { isRecording, clearOnNavigation } = useUIStore.getState();
      useCaptureStore.getState().ingest(message.observations, { recording: isRecording, clearOnNavigation });
    });
    port.postMessage({ type: 'hello', from: 'panel', scope });
    activeConnection = { port, scope };
    return () => {
      if (activeConnection?.port === port) activeConnection = null;
      unsubscribe();
      port.close();
    };
  }, [createPort]);
}

/** Keeps capture-session settings (limits, expiring threshold) in step with persisted preferences. */
export function useCaptureSettingsSync(): void {
  const limits = useUIStore((s) => s.limits);
  const expiringThresholdMs = useUIStore((s) => s.expiringThresholdMs);
  useEffect(() => {
    useCaptureStore.getState().updateSettings({ limits, expiringThresholdMs });
  }, [limits, expiringThresholdMs]);
}
