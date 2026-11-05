/**
 * README poster: the frame of the final cut where the expired token is spotlit, with a play
 * badge, so the README shows what the video is about and links to it.
 * Output: demo/tokenlens-demo-poster.jpg (1600×900).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { STEPS } from '../scenes.mjs';
import { cardDuration } from './brand.mjs';
import { readManifest } from './scenario.mjs';
import { DEMO_DIR, WORK_DIR, ffmpeg, log } from './paths.mjs';

const X = 0.6; // must match the cross-fade in assemble.mjs

export async function poster() {
  const manifest = readManifest();
  const scenario = JSON.parse(readFileSync(join(WORK_DIR, 'tokenlens-demo.json'), 'utf8'));
  const take = JSON.parse(readFileSync(join(WORK_DIR, '.screenplay', 'takes', 'tokenlens-demo', 'take.json'), 'utf8'));
  // Screenplay's planner gives each step's time in the edit; dist/ is not in its exports map.
  const plan = await import(pathToFileURL(join(DEMO_DIR, 'node_modules', 'agent-screenplay', 'dist', 'direct', 'plan.js')).href);
  const audio = new Map(STEPS.map((s, i) => [i, s.line ? manifest[s.line] : undefined]).filter(([, a]) => a));
  const planned = plan.planTake(take, scenario, { fps: 30, audio, autoZoom: true, maxZoom: scenario.style.maxZoom, captions: true, cards: false });
  const index = STEPS.findIndex((s) => s.line === 'culprit');
  const at = cardDuration('intro', manifest) - X + planned.stepTimes[index].o0 + 1.6;

  const frame = join(WORK_DIR, 'poster-frame.png');
  await ffmpeg(['-ss', at.toFixed(3), '-i', join(DEMO_DIR, 'tokenlens-demo.mp4'), '-frames:v', '1', frame]);
  const image = await loadImage(readFileSync(frame));
  const W = 1600;
  const H = 900;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2 - 20;
  ctx.fillStyle = 'rgba(10, 10, 20, 0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx - 18, cy - 28);
  ctx.lineTo(cx + 30, cy);
  ctx.lineTo(cx - 18, cy + 28);
  ctx.closePath();
  ctx.fill();
  const out = join(DEMO_DIR, 'tokenlens-demo-poster.jpg');
  writeFileSync(out, await canvas.encode('jpeg', 88));
  log(`wrote ${out} (frame at ${at.toFixed(2)} s)`);
}

if (process.argv[1] && process.argv[1].endsWith('poster.mjs')) await poster();
