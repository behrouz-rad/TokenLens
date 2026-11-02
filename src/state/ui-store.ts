import { create } from 'zustand';
import { z } from 'zod';
import type { CaptureLimits, DetailTab, MainTab } from '@/types';
import { DEFAULT_CAPTURE_LIMITS, DEFAULT_EXPIRING_THRESHOLD_MS } from '@/types';

export type Theme = 'dark' | 'light';

export const PREFERENCES_STORAGE_KEY = 'tokenlens-preferences';

/**
 * Only non-sensitive UI preferences are persisted. Captured tokens and requests live in memory
 * for the duration of the DevTools session and are never written to storage.
 */
const PreferencesSchema = z.object({
  theme: z.enum(['dark', 'light']).default('dark'),
  clearOnNavigation: z.boolean().default(false),
  expiringThresholdMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).default(DEFAULT_EXPIRING_THRESHOLD_MS),
  maxTokens: z.number().int().min(10).max(10_000).default(DEFAULT_CAPTURE_LIMITS.maxTokens),
  maxRequests: z.number().int().min(100).max(100_000).default(DEFAULT_CAPTURE_LIMITS.maxRequests),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export function loadPreferences(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Preferences {
  const defaults = PreferencesSchema.parse({});
  if (!storage) return defaults;
  try {
    const raw = storage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed: unknown = JSON.parse(raw);
    const result = PreferencesSchema.safeParse(parsed);
    return result.success ? result.data : defaults;
  } catch {
    return defaults;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function persistPreferences(preferences: Preferences): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable (quota, private mode); preferences then last for the session only.
  }
}

interface UIState {
  theme: Theme;
  isRecording: boolean;
  activeMainTab: MainTab;
  activeDetailTab: DetailTab;
  clearOnNavigation: boolean;
  expiringThresholdMs: number;
  limits: CaptureLimits;
  payloadMaximized: boolean;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setRecording: (recording: boolean) => void;
  toggleRecording: () => void;
  setMainTab: (tab: MainTab) => void;
  setDetailTab: (tab: DetailTab) => void;
  setClearOnNavigation: (value: boolean) => void;
  setExpiringThresholdMs: (ms: number) => void;
  setLimits: (limits: CaptureLimits) => void;
  setPayloadMaximized: (value: boolean) => void;
}

function toPreferences(state: UIState): Preferences {
  return {
    theme: state.theme,
    clearOnNavigation: state.clearOnNavigation,
    expiringThresholdMs: state.expiringThresholdMs,
    maxTokens: state.limits.maxTokens,
    maxRequests: state.limits.maxRequests,
  };
}

const initial = loadPreferences();

export const useUIStore = create<UIState>((set, get) => {
  const update = (patch: Partial<UIState>) => {
    set(patch);
    persistPreferences(toPreferences(get()));
  };

  return {
    theme: initial.theme,
    isRecording: true,
    activeMainTab: 'overview',
    activeDetailTab: 'overview',
    clearOnNavigation: initial.clearOnNavigation,
    expiringThresholdMs: initial.expiringThresholdMs,
    limits: { maxTokens: initial.maxTokens, maxRequests: initial.maxRequests },
    payloadMaximized: false,

    setTheme: (theme) => update({ theme }),
    toggleTheme: () => update({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
    setRecording: (isRecording) => set({ isRecording }),
    toggleRecording: () => set({ isRecording: !get().isRecording }),
    setMainTab: (activeMainTab) => set({ activeMainTab }),
    setDetailTab: (activeDetailTab) => set({ activeDetailTab }),
    setClearOnNavigation: (clearOnNavigation) => update({ clearOnNavigation }),
    setExpiringThresholdMs: (expiringThresholdMs) => update({ expiringThresholdMs }),
    setLimits: (limits) => update({ limits }),
    setPayloadMaximized: (payloadMaximized) => set({ payloadMaximized }),
  };
});

export function resetUIStoreForTests(): void {
  const preferences = PreferencesSchema.parse({});
  useUIStore.setState({
    theme: preferences.theme,
    isRecording: true,
    activeMainTab: 'overview',
    activeDetailTab: 'overview',
    clearOnNavigation: preferences.clearOnNavigation,
    expiringThresholdMs: preferences.expiringThresholdMs,
    limits: { maxTokens: preferences.maxTokens, maxRequests: preferences.maxRequests },
    payloadMaximized: false,
  });
}
