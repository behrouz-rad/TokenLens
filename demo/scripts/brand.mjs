/**
 * Renders the branded pieces from demo/brand/brand.html with Playwright's Chromium:
 *   work/brand/background.png   backdrop behind the DevTools window in the Screenplay edit
 *   work/brand/intro.mp4        opening card (length follows the intro narration)
 *   work/brand/outro.mp4        closing card and call to action
 * Each frame is produced by seeking the page to an exact time, so renders are reproducible.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { CARDS } from '../scenes.mjs';
import { readManifest } from './scenario.mjs';
import { DEMO_DIR, FFMPEG, WORK_DIR, log } from './paths.mjs';

const FPS = 30;
const OUT = join(WORK_DIR, 'brand');
/** Where each card's narration starts, and the quiet tail after it. */
export const CARD_TIMING = { intro: { voiceAt: 0.55, tail: 0.45 }, outro: { voiceAt: 0.6, tail: 1.0 } };

export function cardDuration(name, manifest) {
  const { voiceAt, tail } = CARD_TIMING[name];
  const speech = manifest[CARDS[name].line]?.duration ?? 0;
  return Math.max(CARDS[name].minSeconds, voiceAt + speech + tail);
}

async function renderCard(browser, name, seconds) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(`${pathToFileURL(join(DEMO_DIR, 'brand', 'brand.html'))}?scene=${name}`);
  await page.evaluate(() => document.fonts.ready);
  const file = join(OUT, `${name}.mp4`);
  const enc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(FPS), file]);
  const done = new Promise((resolve, reject) => enc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed for ${name}`)))));
  const frames = Math.round(seconds * FPS);
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.seek(t), f / FPS);
    const png = await page.screenshot({ type: 'png' });
    if (!enc.stdin.write(png)) await new Promise((r) => enc.stdin.once('drain', r));
  }
  enc.stdin.end();
  await done;
  await page.close();
  log(`rendered ${name}.mp4 (${seconds.toFixed(2)} s)`);
}

export async function renderBrand() {
  const manifest = readManifest();
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(`${pathToFileURL(join(DEMO_DIR, 'brand', 'brand.html'))}?scene=background`);
    await page.evaluate(() => window.seek(0));
    writeFileSync(join(OUT, 'background.png'), await page.screenshot({ type: 'png' }));
    await page.close();
    for (const name of ['intro', 'outro']) await renderCard(browser, name, cardDuration(name, manifest));
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('brand.mjs')) await renderBrand();
