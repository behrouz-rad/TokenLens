import type { CaptureObservation } from './observation';

/**
 * The DevTools page and the panel are separate documents of the same extension origin, so a
 * BroadcastChannel reaches between them without a background service worker. Every DevTools
 * instance inspects exactly one tab, and the channel name embeds that tab id so two DevTools
 * windows never see each other's traffic. `scope` is the inspected tab id, or "standalone" when
 * the panel runs outside DevTools (development server, UI tests).
 */
export const CHANNEL_PREFIX = 'tokenlens:capture:';

export function captureChannelName(scope: string): string {
  return `${CHANNEL_PREFIX}${scope}`;
}

export function resolveCaptureScope(): string {
  const tabId = typeof chrome === 'undefined' ? undefined : chrome.devtools?.inspectedWindow?.tabId;
  return typeof tabId === 'number' ? String(tabId) : 'standalone';
}

/** `hello` requests a replay; `clear` tells the relay to drop its replay buffer after the user cleared the session. */
export interface PanelMessage {
  type: 'hello' | 'clear';
  from: 'panel';
  scope: string;
}

export type RelayMessage =
  | { type: 'snapshot'; from: 'relay'; relayId: string; scope: string; observations: CaptureObservation[] }
  | { type: 'observations'; from: 'relay'; relayId: string; scope: string; observations: CaptureObservation[] };

export type CaptureMessage = PanelMessage | RelayMessage;

export interface MessagePort {
  postMessage(message: CaptureMessage): void;
  onMessage(handler: (message: CaptureMessage) => void): () => void;
  close(): void;
}

export function createBroadcastPort(scope: string): MessagePort {
  const channel = new BroadcastChannel(captureChannelName(scope));
  return {
    postMessage: (message) => {
      channel.postMessage(message);
    },
    onMessage: (handler) => {
      const listener = (event: MessageEvent<unknown>) => {
        if (isCaptureMessage(event.data) && event.data.scope === scope) handler(event.data);
      };
      channel.addEventListener('message', listener);
      return () => {
        channel.removeEventListener('message', listener);
      };
    },
    close: () => {
      channel.close();
    },
  };
}

export function isCaptureMessage(value: unknown): value is CaptureMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CaptureMessage>;
  if (typeof candidate.scope !== 'string') return false;
  if (candidate.type === 'hello' || candidate.type === 'clear') return candidate.from === 'panel';
  if (candidate.type === 'snapshot' || candidate.type === 'observations') {
    return candidate.from === 'relay' && typeof candidate.relayId === 'string' && Array.isArray(candidate.observations);
  }
  return false;
}
