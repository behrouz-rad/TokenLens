import { describe, expect, it } from 'vitest';
import { loadPreferences, PREFERENCES_STORAGE_KEY } from '@/state/ui-store';
import { loadLayout, saveLayout, LAYOUT_STORAGE_KEY } from '@/lib/layout-storage';

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

describe('preferences persistence', () => {
  it('defaults to dark theme and sane limits when nothing is stored', () => {
    expect(loadPreferences(storage())).toEqual({ theme: 'dark', clearOnNavigation: false, expiringThresholdMs: 300_000, maxTokens: 500, maxRequests: 5000 });
  });

  it('loads stored preferences and rejects tampered or out-of-range values', () => {
    expect(loadPreferences(storage({ [PREFERENCES_STORAGE_KEY]: JSON.stringify({ theme: 'light', maxTokens: 50 }) }))).toMatchObject({ theme: 'light', maxTokens: 50 });
    expect(loadPreferences(storage({ [PREFERENCES_STORAGE_KEY]: JSON.stringify({ theme: 'neon' }) })).theme).toBe('dark');
    expect(loadPreferences(storage({ [PREFERENCES_STORAGE_KEY]: JSON.stringify({ maxTokens: 1 }) })).maxTokens).toBe(500);
    expect(loadPreferences(storage({ [PREFERENCES_STORAGE_KEY]: '{not json' })).theme).toBe('dark');
    expect(loadPreferences(null).theme).toBe('dark');
  });

  it('never contains token material', () => {
    const stored = storage();
    saveLayout({ sidebar: 20, main: 50, inspector: 30 }, stored);
    expect(stored.map.get(LAYOUT_STORAGE_KEY)).not.toMatch(/eyJ/);
  });
});

describe('layout persistence', () => {
  it('round-trips valid layouts and ignores invalid ones', () => {
    const stored = storage();
    saveLayout({ sidebar: 22, main: 48, inspector: 30 }, stored);
    expect(loadLayout(stored)).toEqual({ sidebar: 22, main: 48, inspector: 30 });
    expect(loadLayout(storage({ [LAYOUT_STORAGE_KEY]: JSON.stringify({ sidebar: 'wide' }) }))).toBeUndefined();
    expect(loadLayout(storage({ [LAYOUT_STORAGE_KEY]: 'garbage' }))).toBeUndefined();
    expect(loadLayout(storage())).toBeUndefined();
  });
});
