import { create } from 'zustand';
import type { CaptureLimits, QuickFilterType, RequestFilter, TimelineFilter, TokenFilter, TokenStatus } from '@/types';
import type { CaptureObservation } from '@/core/capture/observation';
import {
  applySettings,
  clearCapture,
  createCaptureState,
  ingestObservations,
  nextStatusTransitionAt,
  refreshStatuses,
  selectToken,
  type CaptureState,
} from '@/core/capture/session';

export interface IngestContext {
  recording: boolean;
  clearOnNavigation: boolean;
}

interface CaptureStore {
  session: CaptureState;
  filter: TokenFilter;
  showExpired: boolean;
  requestFilter: RequestFilter;
  timelineFilter: TimelineFilter;
  /** Request the Requests explorer should scroll to and highlight, set when navigating from the Timeline. */
  focusedRequestId: string | null;

  ingest: (observations: readonly CaptureObservation[], context: IngestContext) => void;
  refresh: () => void;
  clear: () => void;
  select: (tokenId: string | null) => void;
  setSearch: (search: string) => void;
  setStatusFilter: (status: TokenStatus | null) => void;
  setQuickFilter: (filter: QuickFilterType | null) => void;
  clearFilters: () => void;
  setShowExpired: (show: boolean) => void;
  setRequestFilter: (patch: Partial<RequestFilter>) => void;
  clearRequestFilter: () => void;
  setTimelineFilter: (patch: Partial<TimelineFilter>) => void;
  clearTimelineFilter: () => void;
  focusRequest: (requestId: string | null) => void;
  updateSettings: (settings: { limits?: CaptureLimits; expiringThresholdMs?: number }) => void;
}

const EMPTY_FILTER: TokenFilter = { search: '', statusFilter: null, quickFilter: null };
export const EMPTY_REQUEST_FILTER: RequestFilter = { search: '', statusCategory: null, tokenId: null };
export const EMPTY_TIMELINE_FILTER: TimelineFilter = { tokenId: null, eventType: null };

let transitionTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Expiry is driven by exact deadlines, not polling: after every state change the store computes
 * the next instant at which some token changes status and arms a single timer for it.
 */
function scheduleNextTransition(getSession: () => CaptureState, refresh: () => void): void {
  if (transitionTimer !== null) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }
  const now = Date.now();
  const next = nextStatusTransitionAt(getSession(), now);
  if (next === null) return;
  const delay = Math.min(Math.max(next - now, 0) + 1, 2_147_483_647);
  transitionTimer = setTimeout(() => {
    transitionTimer = null;
    refresh();
  }, delay);
}

export const useCaptureStore = create<CaptureStore>((set, get) => {
  const commit = (session: CaptureState) => {
    if (session !== get().session) set({ session });
    scheduleNextTransition(() => get().session, () => get().refresh());
  };

  return {
    session: createCaptureState(),
    filter: EMPTY_FILTER,
    showExpired: false,
    requestFilter: EMPTY_REQUEST_FILTER,
    timelineFilter: EMPTY_TIMELINE_FILTER,
    focusedRequestId: null,

    ingest: (observations, context) => {
      const now = Date.now();
      const next = ingestObservations(get().session, observations, { now, ...context });
      commit(refreshStatuses(next, now));
    },

    refresh: () => {
      commit(refreshStatuses(get().session, Date.now()));
    },

    clear: () => {
      // Token and request ids are reassigned after a clear, so filters bound to them must not survive it.
      set((state) => ({
        requestFilter: { ...state.requestFilter, tokenId: null },
        timelineFilter: { ...state.timelineFilter, tokenId: null },
        focusedRequestId: null,
      }));
      commit(clearCapture(get().session));
    },

    select: (tokenId) => {
      const session = selectToken(get().session, tokenId);
      if (session !== get().session) set({ session });
    },

    setSearch: (search) => set((state) => ({ filter: { ...state.filter, search } })),
    setStatusFilter: (statusFilter) => set((state) => ({ filter: { ...state.filter, statusFilter, quickFilter: null } })),
    setQuickFilter: (quickFilter) => set((state) => ({ filter: { ...state.filter, quickFilter, statusFilter: null } })),
    clearFilters: () => set({ filter: EMPTY_FILTER }),
    setShowExpired: (showExpired) => set({ showExpired }),

    setRequestFilter: (patch) => set((state) => ({ requestFilter: { ...state.requestFilter, ...patch }, focusedRequestId: null })),
    clearRequestFilter: () => set({ requestFilter: EMPTY_REQUEST_FILTER, focusedRequestId: null }),
    setTimelineFilter: (patch) => set((state) => ({ timelineFilter: { ...state.timelineFilter, ...patch } })),
    clearTimelineFilter: () => set({ timelineFilter: EMPTY_TIMELINE_FILTER }),
    // A focused request must be visible, so any explorer filter that could hide it is dropped.
    focusRequest: (focusedRequestId) => set({ focusedRequestId, requestFilter: focusedRequestId ? EMPTY_REQUEST_FILTER : get().requestFilter }),

    updateSettings: (settings) => {
      commit(applySettings(get().session, settings, Date.now()));
    },
  };
});

export function resetCaptureStoreForTests(): void {
  if (transitionTimer !== null) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }
  useCaptureStore.setState({
    session: createCaptureState(),
    filter: EMPTY_FILTER,
    showExpired: false,
    requestFilter: EMPTY_REQUEST_FILTER,
    timelineFilter: EMPTY_TIMELINE_FILTER,
    focusedRequestId: null,
  });
}
