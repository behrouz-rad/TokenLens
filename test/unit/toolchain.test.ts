import { describe, expect, it } from 'vitest';
import ciWorkflow from '../../.github/workflows/ci.yml?raw';
import releaseWorkflow from '../../.github/workflows/release.yml?raw';
import lock from '../../package-lock.json';
import pkg from '../../package.json';
import manifest from '../../manifest.json';

const playwrightVersion = (lock as { packages: Record<string, { version?: string }> }).packages['node_modules/@playwright/test']?.version;

const playwrightImages = (workflow: string) => [...workflow.matchAll(/image:\s*mcr\.microsoft\.com\/playwright:v([\d.]+)-noble/g)].map((m) => m[1]);

/**
 * Linux screenshot baselines are only valid for the Chromium build they were rendered with, so
 * every workflow job that compares them must run inside the Playwright image that matches the
 * installed @playwright/test.
 */
describe('toolchain consistency', () => {
  it('pins the CI Playwright container to the installed @playwright/test version', () => {
    expect(playwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const images = playwrightImages(ciWorkflow);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toBe(playwrightVersion);
  });

  it('pins the release workflow to the same Playwright image', () => {
    const images = playwrightImages(releaseWorkflow);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toBe(playwrightVersion);
  });

  it('keeps manifest.json and package.json at the same version', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  /**
   * The ESLint toolchain pins minimatch to a major that carries a known denial-of-service
   * advisory (GHSA-g3hv-75wg-m249, fixed in 11.0.1). The override lifts every copy to the patched
   * line; it must keep resolving to one installed version and go away once the parents move.
   */
  it('resolves the minimatch override to a single patched version', () => {
    const overrides = (pkg as { overrides?: Record<string, string> }).overrides ?? {};
    expect(Object.keys(overrides)).toEqual(['minimatch']);
    const packages = (lock as { packages: Record<string, { version?: string }> }).packages;
    const installed = Object.entries(packages).filter(([path]) => /(^|\/)node_modules\/minimatch$/.test(path));
    expect(installed.length).toBeGreaterThan(0);
    const versions = new Set(installed.map(([, entry]) => entry.version));
    expect([...versions]).toHaveLength(1);
    const [major, minor, patch] = [...versions][0]!.split('.').map(Number);
    expect(major! > 11 || (major === 11 && (minor! > 0 || patch! >= 1))).toBe(true);
  });
});

/**
 * `playwright test` with no project selects every project, including the headed real-DevTools
 * run that needs a desktop session. The scripts therefore name their projects explicitly, and the
 * workflows call the script instead of repeating the list.
 */
describe('Playwright script selection', () => {
  const projectsOf = (script: string) => [...script.matchAll(/--project[= ]([\w-]+)/g)].map((m) => m[1]).sort();

  it('runs only the headless projects from test:e2e', () => {
    expect(projectsOf(pkg.scripts['test:e2e'])).toEqual(['extension', 'panel-ui']);
    expect(pkg.scripts['test:e2e']).not.toContain('--headed');
  });

  it('runs the real DevTools project only from its own headed scripts', () => {
    expect(projectsOf(pkg.scripts['test:e2e:devtools'])).toEqual(['devtools']);
    expect(pkg.scripts['test:e2e:devtools']).toContain('--headed');
    expect(projectsOf(pkg.scripts['test:e2e:headed'])).toEqual(['devtools', 'extension']);
    expect(pkg.scripts['test:e2e:headed']).toContain('--headed');
  });

  it('keeps the workflows on the test:e2e script rather than a second project list', () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).toContain('npm run test:e2e');
      expect(workflow).not.toMatch(/npx playwright test/);
    }
  });
});
