/** Shared locations and helpers for the demo production scripts. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_DIR = resolve(DEMO_DIR, '..');
export const WORK_DIR = join(DEMO_DIR, 'work');

/** ffmpeg as shipped with Screenplay (ffmpeg-static), so no system install is needed. */
export const FFMPEG = createRequire(import.meta.url)('ffmpeg-static');

export function log(message) {
  process.stdout.write(`${message}\n`);
}

export function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
    });
    let err = '';
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.slice(0, 4).join(' ')}… exited with ${code}\n${err.slice(-2000)}`))));
  });
}

export const ffmpeg = (args) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { quiet: true });
