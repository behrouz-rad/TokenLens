import { z } from 'zod';

export const LAYOUT_STORAGE_KEY = 'tokenlens-layout';

const LayoutSchema = z.record(z.string(), z.number().finite().min(0).max(100));

export type PanelLayout = z.infer<typeof LayoutSchema>;

export function loadLayout(storage: Pick<Storage, 'getItem'> | null = safeStorage()): PanelLayout | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return undefined;
    const result = LayoutSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveLayout(layout: PanelLayout, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Layout persistence is a convenience; failing to save must not break resizing.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
