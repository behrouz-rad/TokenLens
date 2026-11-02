import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipDirectory } from '../../../scripts/release/zip.mjs';
import { sha256Of } from '../../../scripts/release/lib/package.mjs';

/**
 * The CLIs are what the workflows run, so their exit codes, messages and GitHub outputs are
 * tested end to end in a throwaway checkout. The repository's own version files are read only to
 * prove that they were not touched.
 */
const REPO = resolve(__dirname, '../../..');
const SCRIPTS = join(REPO, 'scripts', 'release');
const snapshotRepoVersions = () => ['manifest.json', 'package.json', 'package-lock.json'].map((f) => readFileSync(join(REPO, f), 'utf8'));

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[], options: { cwd: string; env?: Record<string, string> }): RunResult {
  const result = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...options.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const MANIFEST = {
  manifest_version: 3,
  name: 'TokenLens',
  version: '0.1.0',
  devtools_page: 'src/devtools/devtools.html',
  permissions: [],
  icons: { '16': 'icon-16.png' },
};

function writeCheckout(dir: string, version = '0.1.0') {
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ ...MANIFEST, version }, null, 2)}\n`);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'tokenlens', version }, null, 2)}\n`);
  writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify({ name: 'tokenlens', version, lockfileVersion: 3, packages: { '': { name: 'tokenlens', version } } }, null, 2)}\n`);
}

function writeDist(dir: string, version = '0.1.0', extra: Record<string, string> = {}) {
  const files: Record<string, string | Buffer> = {
    'manifest.json': `${JSON.stringify({ ...MANIFEST, version }, null, 2)}\n`,
    'src/devtools/devtools.html': '<!doctype html><title>relay</title>',
    'icon-16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    'assets/panel.js': 'export const panel = 1;',
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// Every test spawns several Node processes; give them room on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

let work: string;
let before: string[];
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'tokenlens-release-cli-'));
  before = snapshotRepoVersions();
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  expect(snapshotRepoVersions()).toEqual(before);
});

describe('check-version.mjs', () => {
  it('accepts a matching version and writes the GitHub outputs', () => {
    writeCheckout(work);
    const output = join(work, 'gh-output.txt');
    const result = run('check-version.mjs', ['--version', '0.1.0', '--latest', '', '--existing-tags', ''], { cwd: work, env: { GITHUB_OUTPUT: output } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Version 0.1.0 is valid');
    expect(readFileSync(output, 'utf8')).toBe('version=0.1.0\ntag=v0.1.0\n');
  });

  it.each([
    [['--version', 'v0.1.0'], /not a valid release version/],
    [['--version', '0.1'], /not a valid release version/],
    [['--version', '00.1.0'], /not a valid release version/],
    [[], /not a valid release version/],
    [['--version', '0.2.0'], /manifest\.json is at 0\.1\.0, expected 0\.2\.0/],
    [['--version', '0.1.0', '--existing-tags', 'v0.0.1,v0.1.0'], /tag v0\.1\.0 already exists/],
    [['--version', '0.1.0', '--latest', 'v0.1.0'], /not higher than the latest release 0\.1\.0/],
    [['--version', '0.1.0', '--latest', 'v0.2.0'], /not higher than the latest release 0\.2\.0/],
  ])('fails with exit 1 and an ::error:: annotation for %j', (args, pattern) => {
    writeCheckout(work);
    const result = run('check-version.mjs', args, { cwd: work });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^::error::/m);
    expect(result.stderr).toMatch(pattern);
  });

  it('accepts a non-monotonic version only with the override, as a warning annotation', () => {
    writeCheckout(work);
    const result = run('check-version.mjs', ['--version', '0.1.0', '--latest', 'v0.2.0', '--allow-non-monotonic'], { cwd: work });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/^::warning::0\.1\.0 is not higher than the latest release 0\.2\.0; allowed by explicit override/m);
  });

  it('reports a lockfile whose root package disagrees with the top-level version', () => {
    writeCheckout(work);
    const lock = JSON.parse(readFileSync(join(work, 'package-lock.json'), 'utf8'));
    lock.packages[''].version = '0.0.9';
    writeFileSync(join(work, 'package-lock.json'), JSON.stringify(lock));
    const result = run('check-version.mjs', ['--version', '0.1.0'], { cwd: work });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/package-lock\.json \(root package\) is at 0\.0\.9, expected 0\.1\.0/);
  });
});

describe('prepare.mjs', () => {
  it('writes the version into the three files of the checkout and nothing else', () => {
    writeCheckout(work);
    const result = run('prepare.mjs', ['1.0.0'], { cwd: work });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Version set to 1.0.0 in manifest.json, package.json, package-lock.json');
    expect(JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8')).version).toBe('1.0.0');
    expect(JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')).version).toBe('1.0.0');
    const lock = JSON.parse(readFileSync(join(work, 'package-lock.json'), 'utf8'));
    expect(lock.version).toBe('1.0.0');
    expect(lock.packages[''].version).toBe('1.0.0');
    expect(run('check-version.mjs', ['--version', '1.0.0', '--latest', 'v0.1.0'], { cwd: work }).status).toBe(0);
  });

  it.each(['', 'v1.0.0', '1.0', '1.0.0-rc1', '01.0.0'])('rejects %j with exit 2 and usage', (version) => {
    writeCheckout(work);
    const result = run('prepare.mjs', version ? [version] : [], { cwd: work });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: node scripts/release/prepare.mjs MAJOR.MINOR.PATCH');
    expect(JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8')).version).toBe('0.1.0');
  });
});

describe('package.mjs and verify-package.mjs', () => {
  it('packages a dist directory, prints the checksum and entries, and the archive verifies against the checksum and dist', () => {
    const dist = writeDist(join(work, 'dist'));
    const out = join(work, 'release');
    const output = join(work, 'gh-output.txt');
    const result = run('package.mjs', ['--version', '0.1.0', '--dist', dist, '--out', out], { cwd: work, env: { GITHUB_OUTPUT: output } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Packaged TokenLens-v0\.1\.0\.zip \(4 files, \d+ bytes\)/);
    expect(result.stdout).toMatch(/SHA-256 [0-9a-f]{64}/);
    expect(result.stdout).toContain('  manifest.json');
    const zip = readFileSync(join(out, 'TokenLens-v0.1.0.zip'));
    const sha = sha256Of(zip);
    expect(readFileSync(output, 'utf8')).toBe(`zip=${join(out, 'TokenLens-v0.1.0.zip')}\nzip_name=TokenLens-v0.1.0.zip\nsha256=${sha}\n`);
    expect(JSON.parse(readFileSync(join(out, 'provenance.json'), 'utf8'))).toMatchObject({ version: '0.1.0', sha256: sha, entries: 4 });

    const verify = run('verify-package.mjs', ['--zip', join(out, 'TokenLens-v0.1.0.zip'), '--version', '0.1.0', '--checksum', join(out, 'TokenLens-v0.1.0.zip.sha256'), '--sha256', sha, '--dist', dist], { cwd: work });
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toMatch(/Verified .*TokenLens-v0\.1\.0\.zip: SHA-256 [0-9a-f]{64}, 4 files, manifest version 0\.1\.0, identical to /);
  });

  it('packaging the same dist twice gives the same archive bytes', () => {
    const dist = writeDist(join(work, 'dist'));
    expect(run('package.mjs', ['--version', '0.1.0', '--dist', dist, '--out', join(work, 'a')], { cwd: work }).status).toBe(0);
    expect(run('package.mjs', ['--version', '0.1.0', '--dist', dist, '--out', join(work, 'b')], { cwd: work }).status).toBe(0);
    expect(readFileSync(join(work, 'a', 'TokenLens-v0.1.0.zip')).equals(readFileSync(join(work, 'b', 'TokenLens-v0.1.0.zip')))).toBe(true);
    expect(readFileSync(join(work, 'a', 'TokenLens-v0.1.0.zip.sha256'), 'utf8')).toBe(readFileSync(join(work, 'b', 'TokenLens-v0.1.0.zip.sha256'), 'utf8'));
  });

  it('fails with usage when the version is missing or malformed', () => {
    for (const args of [[], ['--version', 'v1.0.0'], ['--version', '1.0']]) {
      const result = run('package.mjs', args, { cwd: work });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('usage: node scripts/release/package.mjs --version X.Y.Z');
    }
  });

  it('fails when the dist directory is missing or has no manifest, without writing an archive', () => {
    mkdirSync(join(work, 'empty'));
    for (const dist of [join(work, 'empty'), join(work, 'absent')]) {
      const result = run('package.mjs', ['--version', '0.1.0', '--dist', dist, '--out', join(work, 'release')], { cwd: work });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/does not contain manifest\.json; run "npm run build" first/);
    }
    expect(existsSync(join(work, 'release'))).toBe(false);
  });

  it('fails when the manifest version differs from the release version', () => {
    const dist = writeDist(join(work, 'dist'), '0.1.0');
    const result = run('package.mjs', ['--version', '0.2.0', '--dist', dist, '--out', join(work, 'release')], { cwd: work });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Package verification failed for TokenLens-v0.2.0.zip:');
    expect(result.stderr).toContain('  - manifest version is 0.1.0, expected 0.2.0');
  });

  it('fails when development files or fixture content are in dist', () => {
    const dist = writeDist(join(work, 'dist'), '0.1.0', { 'assets/panel.js.map': '{}', 'assets/panel.js': 'const seed = createMockObservations();' });
    const result = run('package.mjs', ['--version', '0.1.0', '--dist', dist, '--out', join(work, 'release')], { cwd: work });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('  - development file packaged: assets/panel.js.map');
    expect(result.stderr).toContain('  - assets/panel.js contains forbidden content "createMockObservations"');
  });

  it('verify-package rejects a tampered archive, a wrong checksum, a wrong version and a dist that differs', () => {
    const dist = writeDist(join(work, 'dist'));
    const out = join(work, 'release');
    expect(run('package.mjs', ['--version', '0.1.0', '--dist', dist, '--out', out], { cwd: work }).status).toBe(0);
    const zipPath = join(out, 'TokenLens-v0.1.0.zip');
    const original = readFileSync(zipPath);

    const wrongSha = run('verify-package.mjs', ['--zip', zipPath, '--version', '0.1.0', '--sha256', 'f'.repeat(64)], { cwd: work });
    expect(wrongSha.status).toBe(1);
    expect(wrongSha.stderr).toMatch(/SHA-256 mismatch/);

    const wrongVersion = run('verify-package.mjs', ['--zip', zipPath, '--version', '0.2.0'], { cwd: work });
    expect(wrongVersion.status).toBe(1);
    expect(wrongVersion.stderr).toContain('manifest version is 0.1.0, expected 0.2.0');

    const otherDist = writeDist(join(work, 'other'), '0.1.0', { 'assets/panel.js': 'export const panel = 2;' });
    const differs = run('verify-package.mjs', ['--zip', zipPath, '--version', '0.1.0', '--dist', otherDist], { cwd: work });
    expect(differs.status).toBe(1);
    expect(differs.stderr).toContain('assets/panel.js differs between dist and the archive');

    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    writeFileSync(zipPath, tampered);
    const checksum = run('verify-package.mjs', ['--zip', zipPath, '--version', '0.1.0', '--checksum', `${zipPath}.sha256`], { cwd: work });
    expect(checksum.status).toBe(1);
    expect(checksum.stderr).toMatch(/SHA-256 mismatch/);

    writeFileSync(zipPath, Buffer.from('definitely not a zip archive at all'));
    const garbage = run('verify-package.mjs', ['--zip', zipPath, '--version', '0.1.0'], { cwd: work });
    expect(garbage.status).toBe(1);
    expect(garbage.stderr).toMatch(/not a ZIP archive/);

    const zipOnlyBad = run('verify-package.mjs', ['--zip', join(work, 'missing.zip'), '--version', '0.1.0'], { cwd: work });
    expect(zipOnlyBad.status).toBe(1);
    expect(zipOnlyBad.stderr).toMatch(/cannot read/);

    expect(run('verify-package.mjs', ['--zip', zipPath], { cwd: work }).status).toBe(2);
  });

  it('verify-package accepts an archive produced by the zip writer directly', () => {
    const dist = writeDist(join(work, 'dist'));
    const zipPath = join(work, 'direct.zip');
    writeFileSync(zipPath, zipDirectory(dist));
    const result = run('verify-package.mjs', ['--zip', zipPath, '--version', '0.1.0', '--dist', dist], { cwd: work });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('cws-publish.mjs', () => {
  it('fails before any network access when the token is missing, without echoing arguments that could be secrets', () => {
    const dist = writeDist(join(work, 'dist'));
    const zipPath = join(work, 'pkg.zip');
    writeFileSync(zipPath, zipDirectory(dist));
    const result = run('cws-publish.mjs', ['--publisher', 'p', '--item', 'abcdefghijklmnopabcdefghijklmnop', '--zip', zipPath, '--expect-version', '0.1.0', '--action', 'upload'], { cwd: work, env: { CWS_ACCESS_TOKEN: '' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^::error::no access token: CWS_ACCESS_TOKEN is not set/m);
  });

  it('fails on a missing package or an unknown action', () => {
    const missing = run('cws-publish.mjs', ['--publisher', 'p', '--item', 'abcdefghijklmnopabcdefghijklmnop', '--zip', join(work, 'nope.zip'), '--expect-version', '0.1.0'], { cwd: work, env: { CWS_ACCESS_TOKEN: 'synthetic' } });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/^::error::cannot read .*nope\.zip/m);
    expect(missing.stderr).not.toContain('synthetic');

    const zipPath = join(work, 'pkg.zip');
    writeFileSync(zipPath, zipDirectory(writeDist(join(work, 'dist'))));
    const unknown = run('cws-publish.mjs', ['--publisher', 'p', '--item', 'abcdefghijklmnopabcdefghijklmnop', '--zip', zipPath, '--expect-version', '0.1.0', '--action', 'publish-now'], { cwd: work, env: { CWS_ACCESS_TOKEN: 'synthetic' } });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/^::error::unknown --action "publish-now"; use upload-only, submit-for-review or submit-staged/m);
    expect(unknown.stderr).not.toContain('synthetic');
  });
});
