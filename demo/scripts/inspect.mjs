/**
 * Quality check of the final video: stream facts, measured loudness, and a contact sheet
 * (work/review/contact-sheet.png) with one frame every few seconds for visual review.
 *   node scripts/inspect.mjs [file]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_DIR, FFMPEG, WORK_DIR, ffmpeg, log } from './paths.mjs';

const file = process.argv[2] ?? join(DEMO_DIR, 'tokenlens-demo.mp4');

function stderrOf(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', () => resolve(err));
  });
}

const info = await stderrOf(['-i', file]);
const duration = /Duration: ([\d:.]+)/.exec(info)?.[1];
const video = /Stream #\d+:\d+[^:]*: Video: ([^\n]+)/.exec(info)?.[1] ?? '';
const audio = /Stream #\d+:\d+[^:]*: Audio: ([^\n]+)/.exec(info)?.[1] ?? '';
log(`file      ${file}`);
log(`duration  ${duration}`);
log(`video     ${video.trim()}`);
log(`audio     ${audio.trim()}`);

const loud = await stderrOf(['-i', file, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
const summary = loud.slice(loud.lastIndexOf('Summary:'));
const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1];
const peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1];
log(`loudness  ${integrated} LUFS integrated, true peak ${peak} dBFS`);

const frames = Number((/(\d+) fps/.exec(video) ?? [])[1] ?? 30);
const out = join(WORK_DIR, 'review');
mkdirSync(out, { recursive: true });
await ffmpeg(['-i', file, '-vf', `fps=1/3,scale=640:-1,tile=4x6:padding=8:color=0x111114`, '-frames:v', '1', join(out, 'contact-sheet.png')]);
log(`contact sheet ${join(out, 'contact-sheet.png')} (one frame every 3 s, ${frames} fps source)`);
