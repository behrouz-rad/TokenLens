import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/**
 * jsdom performs no layout, so every element measures 0×0 and TanStack Virtual would render no
 * rows. Scroll containers are given a tall viewport and virtual rows a fixed height so lists
 * render enough items for assertions; everything else keeps jsdom's default.
 */
if (typeof Element !== 'undefined') {
  const isScrollContainer = (el: Element) => el.getAttribute('role') === 'listbox' || el.hasAttribute('data-virtual-scroll');
  const original = Element.prototype.getBoundingClientRect;
  const rect = (width: number, height: number): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    if (this.hasAttribute('data-index')) return rect(400, 68);
    if (isScrollContainer(this)) return rect(400, 2000);
    return original.call(this);
  };
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isScrollContainer(this) ? 2000 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isScrollContainer(this) ? 400 : 0;
    },
  });
}
