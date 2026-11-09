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

export const RECORDER_ONLY = new Set(['scene', 'line', 'play', 'wheel', 'paste', 'expect']);
const KINDS = ['click', 'hover', 'highlight', 'callout', 'zoomTo', 'pause', 'type', 'scroll', 'wait'];

export const SCENARIO_FILE = join(WORK_DIR, 'tokenlens-demo.json');
export const DIRECTIONS_FILE = join(WORK_DIR, 'directions.json');

export function readManifest() {
  const file = join(WORK_DIR, 'narration', 'manifest.json');
  if (!existsSync(file)) throw new Error('No narration yet: run `node scripts/narrate.mjs` first.');
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Rejects steps the DevTools recorder would misread, before anything is filmed: one action per
 * step, known narration lines, `paste` only on a click into a panel field, `expect` as
 * [{ in, text }] with non-empty strings.
 */
export function validateSteps(steps, lines) {
  steps.forEach((step, index) => {
    const at = `step ${index + 1}`;
    const kinds = KINDS.filter((k) => k in step);
    if (kinds.length !== 1) throw new Error(`${at} needs exactly one action, found ${kinds.length ? kinds.join(', ') : 'none'}`);
    if (step.line !== undefined && !(step.line in lines)) throw new Error(`${at}: unknown narration line "${step.line}"`);
    if (step.paste !== undefined) {
      if (kinds[0] !== 'click') throw new Error(`${at}: paste needs a click step that focuses the field`);
      if (typeof step.paste !== 'string' || !step.paste) throw new Error(`${at}: paste names a sample of the demo page`);
      if (step.click.startsWith('devtools:')) throw new Error(`${at}: paste targets a field in the TokenLens panel`);
    }
    if (step.expect !== undefined) {
      const ok = Array.isArray(step.expect) && step.expect.length > 0 && step.expect.every(
        (e) => e && typeof e.in === 'string' && e.in && typeof e.text === 'string' && e.text && Object.keys(e).length === 2
      );
      if (!ok) throw new Error(`${at}: expect is a non-empty list of { in, text }`);
    }
  });
}

export function buildScenario(manifest, steps = STEPS, lines = LINES) {
  validateSteps(steps, lines);
  const scenarioSteps = steps.map((step, index) => {
    const out = Object.fromEntries(Object.entries(step).filter(([k]) => !RECORDER_ONLY.has(k)));
    if (step.line) {
      const line = lines[step.line];
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
    steps: scenarioSteps,
  };
}

export function buildDirections(manifest, steps = STEPS, lines = LINES) {
  validateSteps(steps, lines);
  return {
    viewport: VIEWPORT,
    steps: steps.map((step, index) => {
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
        paste: step.paste,
        expect: step.expect,
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
