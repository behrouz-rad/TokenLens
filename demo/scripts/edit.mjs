/**
 * Edits the DevTools take with Screenplay: smooth cursor, spring zooms, click ripples,
 * highlights, captions and the narration track, onto the branded backdrop.
 * Output: work/main.mp4 and work/main.storyboard.png.
 */
import { join } from 'node:path';
import { DEMO_DIR, WORK_DIR, run } from './paths.mjs';

export async function edit() {
  const cli = join(DEMO_DIR, 'node_modules', 'agent-screenplay', 'dist', 'cli.js');
  await run(process.execPath, [cli, 'render', join(WORK_DIR, 'tokenlens-demo.json')]);
}

if (process.argv[1] && process.argv[1].endsWith('edit.mjs')) await edit();
