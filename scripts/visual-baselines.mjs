/**
 * Runs the Playwright `panel-ui` project inside the same pinned Playwright image that CI uses, so
 * Linux screenshot baselines are produced by the exact browser build, OS, fonts and viewport that
 * will later compare against them. Baselines written by a differently configured machine would
 * either fail CI or need a tolerance wide enough to hide real regressions.
 *
 *   node scripts/visual-baselines.mjs            update the linux baselines (review the diff before committing)
 *   node scripts/visual-baselines.mjs --check    compare against the committed linux baselines without writing
 *   node scripts/visual-baselines.mjs -- <args>  pass extra arguments to `playwright test` (e.g. a spec filter)
 *
 * Requires Docker. The image tag is derived from the installed @playwright/test version so it
 * cannot drift from the version in package-lock.json; the CI workflow pins the same tag.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const playwrightVersion = lock.packages['node_modules/@playwright/test']?.version;
if (!playwrightVersion) throw new Error('@playwright/test not found in package-lock.json');

export const PLAYWRIGHT_IMAGE = `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`;

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const separator = argv.indexOf('--');
const extraArgs = separator >= 0 ? argv.slice(separator + 1) : [];

const playwrightArgs = ['--project=panel-ui', ...(check ? [] : ['--update-snapshots']), ...extraArgs].map((a) => JSON.stringify(a)).join(' ');

// The repository is mounted read-only at /src and copied into the container so Linux-native
// node_modules never mix with the host's. Only the linux screenshot folder is copied back.
const script = [
  'set -euo pipefail',
  'mkdir -p /work && cd /work',
  'tar -C /src --exclude=./node_modules --exclude=./dist --exclude=./test-results --exclude=./playwright-report --exclude=./.git -cf - . | tar -xf -',
  'npm ci --no-audit --no-fund --prefer-offline',
  'npm run build',
  `xvfb-run --auto-servernum -- npx playwright test ${playwrightArgs}`,
  ...(check ? [] : ['mkdir -p /src/e2e/tests/__screenshots__', 'rm -rf /src/e2e/tests/__screenshots__/linux', 'cp -r e2e/tests/__screenshots__/linux /src/e2e/tests/__screenshots__/linux']),
].join('\n');

const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    // tini as PID 1: xvfb-run must not be PID 1 or it never receives Xvfb's readiness signal.
    '--init',
    '--ipc=host',
    '-e',
    'CI=1',
    '-v',
    `${root}:/src${check ? ':ro' : ''}`,
    '-v',
    'tokenlens-npm-cache:/root/.npm',
    PLAYWRIGHT_IMAGE,
    'bash',
    '-lc',
    script,
  ],
  { stdio: 'inherit' }
);

if (result.error) {
  console.error(`Could not start Docker: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
