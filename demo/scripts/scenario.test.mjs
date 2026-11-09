/**
 * Checks the step serialization the recorder and the edit rely on:
 *   npm test in demo/
 * Screenplay's own strict schema is loaded from its file, because the package exports only its CLI
 * entry point.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { LINES, STEPS } from '../scenes.mjs';
import { RECORDER_ONLY, buildDirections, buildScenario, validateSteps } from './scenario.mjs';
import { WORK_DIR } from './paths.mjs';

const { Scenario } = await import(new URL('../node_modules/agent-screenplay/dist/scenario/schema.js', import.meta.url).href);

const manifest = Object.fromEntries(Object.keys(LINES).map((id) => [id, { file: join(WORK_DIR, 'narration', `${id}.wav`), duration: 2 }]));
const pasteStep = STEPS.findIndex((s) => s.paste !== undefined);

test('the scenario passes Screenplay strict schema with every recorder-only field removed', () => {
  const scenario = buildScenario(manifest);
  const parsed = Scenario.safeParse(scenario);
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)));
  for (const step of scenario.steps) for (const key of RECORDER_ONLY) assert.equal(key in step, false, `${key} leaked into the scenario`);
  assert.equal(scenario.steps.length, STEPS.length);
});

test('the paste step stays a click in the scenario, with its narration attached', () => {
  assert.notEqual(pasteStep, -1);
  const step = buildScenario(manifest).steps[pasteStep];
  assert.equal(step.click, STEPS[pasteStep].click);
  assert.equal(step.say, LINES[STEPS[pasteStep].line].caption);
  assert.equal(step.audio, `narration/${STEPS[pasteStep].line}.wav`);
});

test('directions carry paste and expect to the recorder unchanged', () => {
  const directions = buildDirections(manifest).steps;
  assert.equal(directions[pasteStep].kind, 'click');
  assert.equal(directions[pasteStep].paste, STEPS[pasteStep].paste);
  assert.deepEqual(directions[pasteStep].expect, STEPS[pasteStep].expect);
  assert.equal(directions[pasteStep].minDuration, 2 + 0.35);
  for (const [i, step] of STEPS.entries()) if (step.expect === undefined) assert.equal(directions[i].expect, undefined);
});

test('steps the recorder would misread are rejected before filming', () => {
  const lines = { a: { caption: 'A.' } };
  const bad = [
    [{ highlight: 'testid=x', paste: 'decoder' }, /paste needs a click/],
    [{ click: 'devtools:tab=TokenLens', paste: 'decoder' }, /panel/],
    [{ click: 'testid=x', paste: '' }, /names a sample/],
    [{ click: 'testid=x', expect: [] }, /expect/],
    [{ click: 'testid=x', expect: [{ in: 'testid=y' }] }, /expect/],
    [{ click: 'testid=x', expect: [{ in: 'testid=y', text: 'z', extra: 1 }] }, /expect/],
    [{ click: 'testid=x', highlight: 'testid=y' }, /exactly one action/],
    [{ scene: 'x' }, /exactly one action/],
    [{ click: 'testid=x', line: 'missing' }, /unknown narration line/],
  ];
  for (const [step, message] of bad) assert.throws(() => validateSteps([step], lines), message, JSON.stringify(step));
  assert.doesNotThrow(() => validateSteps([{ click: 'testid=x', paste: 'decoder', line: 'a', expect: [{ in: 'testid=y', text: 'z' }] }], lines));
});
