import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * Resolves once every running finite CSS transition and animation has finished. axe-core reads
 * computed colours, so a scan started while a theme switch, tab change, popover slide-in or dialog
 * fade-in is still interpolating measures intermediate colours the settled UI never shows, and
 * whether it does depends only on runner speed. Infinite animations (the recording and expiring
 * pulses) never finish and are not waited for.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (;;) {
      const running = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity);
      if (running.length === 0) return;
      // An interrupted transition rejects `finished` and is replaced by a new one, which the next pass picks up.
      await Promise.allSettled(running.map((a) => a.finished));
    }
  });
}

/** WCAG 2 A/AA violations of the settled page, reduced to rule id, impact and the first node selectors. */
export async function scanWcag(page: Page) {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5) }));
}
