/**
 * Produces demo/tokenlens-demo.mp4 from scratch:
 *   1. build the extension (npm run build + verify:manifest in the repository root)
 *   2. narration (Kokoro, cached)          scripts/narrate.mjs
 *   3. scenario + recorder directions      scripts/scenario.mjs
 *   4. rehearsal, then the real DevTools take (demo/record.spec.ts), reshot when rejected
 *   5. brand cards and backdrop            scripts/brand.mjs
 *   6. Screenplay edit                     scripts/edit.mjs
 *   7. final cut and mix                   scripts/assemble.mjs
 * Flags: --skip-build (reuse dist/), --skip-record (re-edit the last take), --no-music.
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDirections, buildScenario, readManifest, DIRECTIONS_FILE, SCENARIO_FILE } from './scenario.mjs';
import { renderBrand } from './brand.mjs';
import { edit } from './edit.mjs';
import { assemble } from './assemble.mjs';
import { DEMO_DIR, ROOT_DIR, WORK_DIR, log, run } from './paths.mjs';

const has = (flag) => process.argv.includes(flag);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const playwright = join(ROOT_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
const record = (env = {}) =>
  run(process.execPath, [playwright, 'test', '-c', 'demo/playwright.config.ts'], { cwd: ROOT_DIR, env: { ...process.env, ...env } });

if (!has('--skip-build')) {
  log('== building the extension');
  await run(npm, ['run', 'build'], { cwd: ROOT_DIR, shell: true });
  await run(npm, ['run', 'verify:manifest'], { cwd: ROOT_DIR, shell: true });
} else if (!existsSync(join(ROOT_DIR, 'dist', 'manifest.json'))) {
  throw new Error('dist/ is missing: run `npm run build` in the repository root or drop --skip-build.');
}

log('== narration');
await run(process.execPath, [join(DEMO_DIR, 'scripts', 'narrate.mjs')]);
const manifest = readManifest();
mkdirSync(WORK_DIR, { recursive: true });
writeFileSync(SCENARIO_FILE, JSON.stringify(buildScenario(manifest), null, 2));
writeFileSync(DIRECTIONS_FILE, JSON.stringify(buildDirections(manifest), null, 2));

if (!has('--skip-record')) {
  log('== rehearsal in real DevTools');
  await record({ DEMO_CHECK: '1' }).catch(() => log('rehearsal rejected; continuing to the takes'));
  for (let attempt = 1; ; attempt++) {
    log(`== take ${attempt}`);
    try {
      await record();
      break;
    } catch (error) {
      // A rejected take fails within its first step (~20 s), so reshooting is cheap.
      if (attempt >= 12) throw error;
      log(`take ${attempt} rejected, reshooting`);
    }
  }
}

log('== brand cards');
await renderBrand();
log('== Screenplay edit');
await edit();
log('== final cut');
await assemble({ music: !has('--no-music') });
