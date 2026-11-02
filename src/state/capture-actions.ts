import { toast } from 'sonner';
import { useCaptureStore } from '@/state/capture-store';
import { useUIStore } from '@/state/ui-store';
import { notifyRelayCleared } from '@/hooks/use-capture-connection';
import { pluralize } from '@/lib/format';

export function clearCaptureWithFeedback(): void {
  const { session, clear } = useCaptureStore.getState();
  const tokenCount = session.tokens.size;
  const requestCount = session.requests.size;
  clear();
  notifyRelayCleared();
  toast.success(
    tokenCount === 0 && requestCount === 0 ? 'Nothing to clear' : `Cleared ${pluralize(tokenCount, 'token')} and ${pluralize(requestCount, 'request')}`
  );
}

/** Selects a token and switches to the Overview so its details are on screen. */
export function showTokenInOverview(tokenId: string): void {
  const capture = useCaptureStore.getState();
  if (!capture.session.tokens.has(tokenId)) {
    toast.error('That token is no longer in the capture session');
    return;
  }
  capture.select(tokenId);
  useUIStore.getState().setMainTab('overview');
}

/** Opens the Requests explorer scrolled to one request. */
export function showRequestInExplorer(requestId: string): void {
  const capture = useCaptureStore.getState();
  if (!capture.session.requests.has(requestId)) {
    toast.error('That request is no longer in the capture session');
    return;
  }
  capture.focusRequest(requestId);
  useUIStore.getState().setMainTab('requests');
}
