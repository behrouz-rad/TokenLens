import { useSyncExternalStore } from 'react';

type Listener = () => void;

/**
 * One shared interval drives every relative-time label in the panel. It only runs while at
 * least one component subscribes and each subscriber re-renders only when its own quantised
 * value changes, so a 1 s label and a 30 s label never cause extra renders for each other.
 */
class SharedTicker {
  private listeners = new Set<Listener>();
  private handle: ReturnType<typeof setInterval> | null = null;
  private current = Date.now();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    if (this.handle === null) {
      this.current = Date.now();
      this.handle = setInterval(() => {
        this.current = Date.now();
        for (const l of this.listeners) l();
      }, 1000);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.handle !== null) {
        clearInterval(this.handle);
        this.handle = null;
      }
    };
  };

  now = (): number => (this.handle === null ? Date.now() : this.current);
}

export const ticker = new SharedTicker();

export function useNow(intervalMs = 1000): number {
  const step = Math.max(1000, intervalMs);
  return useSyncExternalStore(
    ticker.subscribe,
    () => Math.floor(ticker.now() / step) * step,
    () => Math.floor(Date.now() / step) * step
  );
}
