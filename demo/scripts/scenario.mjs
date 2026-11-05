/**
 * Builds the two files the recording and the edit run from:
 *
 *   work/tokenlens-demo.json   the Screenplay scenario (strict schema: recorder-only fields removed,
 *                              narration attached as `say` + `audio`)
 *   work/directions.json       what the DevTools recorder needs: targets, traffic bursts and how
 *                              long each step must last for its narration
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LINES, STEPS, VIEWPORT } from '../scenes.mjs';
import { WORK_DIR, log } from './paths.mjs';

const RECORDER_ONLY = new Set(['scene', 'line', 'play', 'wheel']);
const KINDS = ['click', 'hover', 'highlight', 'callout', 'zoomTo', 'pause', 'type', 'scroll', 'wait'];

export const SCENARIO_FILE = join(WORK_DIR, 'tokenlens-demo.json');
export const DIRECTIONS_FILE = join(WORK_DIR, 'directions.json');

export function readManifest() {
  const file = join(WORK_DIR, 'narration', 'manifest.json');
  if (!existsSync(file)) throw new Error('No narration yet: run `node scripts/narrate.mjs` first.');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function buildScenario(manifest) {
  const steps = STEPS.map((step, index) => {
    const kind = KINDS.find((k) => k in step);
    if (!kind) throw new Error(`step ${index + 1} has no supported action`);
    const out = Object.fromEntries(Object.entries(step).filter(([k]) => !RECORDER_ONLY.has(k)));
    if (step.line) {
      const line = LINES[step.line];
      const clip = manifest[step.line];
      if (!line || !clip) throw new Error(`step ${index + 1}: unknown narration line "${step.line}"`);
      out.say = line.caption;
      out.audio = relative(WORK_DIR, clip.file).replaceAll('\\', '/');
    }
    return out;
  });
  return {
    $schema: 'https://raw.githubusercontent.com/gmpetrov/agent-screenplay/main/schema/scenario.schema.json',
    name: 'tokenlens-demo',
    // Required by the schema; the take itself comes from demo/record.spec.ts (real DevTools), not
    // from `screenplay record`, which can only film a plain page in its own headless browser.
    url: 'http://app.example.test/',
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    scale: VIEWPORT.scale,
    style: {
      background: 'brand/background.png',
      padding: 60,
      radius: 14,
      shadow: true,
      cursor: 'arrow',
      cursorSize: 0.9,
      click: 'ripple',
      maxZoom: 1.75,
      accent: '#6366f1',
      captions: true,
      cards: false,
      frame: 'none',
    },
    output: { width: 1920, height: 1080, fps: 30, path: 'main.mp4' },
    steps,
  };
}

export function buildDirections(manifest) {
  return {
    viewport: VIEWPORT,
    steps: STEPS.map((step, index) => {
      const kind = KINDS.find((k) => k in step);
      const clip = step.line ? manifest[step.line] : undefined;
      return {
        index,
        kind,
        scene: step.scene,
        target: typeof step[kind] === 'string' ? step[kind] : undefined,
        seconds: typeof step[kind] === 'number' ? step[kind] : undefined,
        play: step.play,
        wheel: step.wheel,
        hold: step.hold,
        duration: step.duration,
        // Same rule as Screenplay's own recorder: the step lasts until its sentence has been heard.
        minDuration: clip ? clip.duration + 0.35 : 0,
      };
    }),
  };
}

if (process.argv[1] && process.argv[1].endsWith('scenario.mjs')) {
  const manifest = readManifest();
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(SCENARIO_FILE, JSON.stringify(buildScenario(manifest), null, 2));
  writeFileSync(DIRECTIONS_FILE, JSON.stringify(buildDirections(manifest), null, 2));
  log(`wrote ${relative(process.cwd(), SCENARIO_FILE)} and ${relative(process.cwd(), DIRECTIONS_FILE)}`);
}
