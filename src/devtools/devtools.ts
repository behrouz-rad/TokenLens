import { createBroadcastPort, resolveCaptureScope } from '@/core/capture/channel';
import { CaptureRelay, createChromeNetworkApi, createRelayId } from '@/core/capture/relay';

declare global {
  interface Window {
    __tokenlensRelay?: CaptureRelay;
  }
}

/**
 * The DevTools page is a hidden document that lives as long as DevTools is open. Keeping one
 * relay instance on `window` guards against duplicate listeners if the module is re-evaluated
 * during development hot reloads.
 */
function startRelay(): void {
  if (window.__tokenlensRelay) return;
  const scope = resolveCaptureScope();
  const relay = new CaptureRelay({
    relayId: createRelayId(),
    scope,
    port: createBroadcastPort(scope),
    api: createChromeNetworkApi(chrome.devtools.network),
  });
  relay.start();
  window.__tokenlensRelay = relay;
  window.addEventListener('unload', () => relay.stop(), { once: true });
}

startRelay();

void chrome.devtools.panels.create('TokenLens', 'src/assets/icon-128.png', 'src/devtools/panel/panel.html');
