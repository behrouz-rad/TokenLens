import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, listFiles, readZipEntries, readZipEntry, zipDirectory } from '../../../scripts/release/zip.mjs';
import { buildPackage, buildProvenance, parseChecksumFile, sha256Of, verifyPackage, verifyPackageMatchesDist, zipNameFor } from '../../../scripts/release/lib/package.mjs';

/**
 * A second, unrelated ZIP implementation must agree with ours; otherwise a bug in the writer and
 * the reader could cancel out. Python's `zipfile` and Info-ZIP's `unzip` are standard tooling on
 * the CI image, so missing both there is a failure rather than a skip.
 */
interface ZipTool {
  name: string;
  test: (zipPath: string) => { ok: boolean; output: string };
  list: (zipPath: string) => string[];
  extract: (zipPath: string, dir: string) => void;
}

function findZipTool(): ZipTool | null {
  for (const python of ['python3', 'python']) {
    const probe = spawnSync(python, ['-c', 'import zipfile, sys; sys.stdout.write("ok")'], { encoding: 'utf8' });
    if (probe.status !== 0 || probe.stdout !== 'ok') continue;
    return {
      name: `${python} -m zipfile`,
      test: (zipPath) => {
        const r = spawnSync(python, ['-I', '-m', 'zipfile', '-t', zipPath], { encoding: 'utf8' });
        // The zipfile CLI exits 0 even for a corrupted member; it reports the member by name instead.
        return { ok: r.status === 0 && r.stdout.includes('Done testing') && !r.stdout.includes('corrupted'), output: `${r.stdout}${r.stderr}` };
      },
      list: (zipPath) => {
        const r = spawnSync(python, ['-I', '-c', 'import zipfile, sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', zipPath], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout.split(/\r?\n/).filter(Boolean);
      },
      extract: (zipPath, dir) => {
        const r = spawnSync(python, ['-I', '-m', 'zipfile', '-e', zipPath, dir], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
      },
    };
  }
  const unzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
  if (unzip.status === 0) {
    return {
      name: 'unzip',
      test: (zipPath) => {
        const r = spawnSync('unzip', ['-tq', zipPath], { encoding: 'utf8' });
        return { ok: r.status === 0 && r.stdout.includes('No errors detected'), output: `${r.stdout}${r.stderr}` };
      },
      list: (zipPath) => {
        const r = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout.split(/\r?\n/).filter(Boolean);
      },
      extract: (zipPath, dir) => {
        const r = spawnSync('unzip', ['-q', zipPath, '-d', dir], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
      },
    };
  }
  return null;
}

const zipTool = findZipTool();
/** Each external invocation starts an interpreter; on a loaded machine that takes seconds, not milliseconds. */
const EXTERNAL_TOOL_TIMEOUT_MS = 60_000;
const independent = zipTool !== null || !!process.env.CI;
const requireZipTool = (): ZipTool => {
  if (!zipTool) throw new Error('no independent ZIP tool (python zipfile or unzip) is available on this CI image');
  return zipTool;
};

const VERSION = '1.2.3';
const MANIFEST = {
  manifest_version: 3,
  name: 'TokenLens',
  description: 'synthetic fixture',
  version: VERSION,
  minimum_chrome_version: '116',
  devtools_page: 'src/devtools/devtools.html',
  permissions: [],
  icons: { '16': 'src/assets/icon-16.png', '48': 'src/assets/icon-48.png', '128': 'src/assets/icon-128.png' },
};

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Writes a synthetic production tree shaped like the real `dist/`. */
function writeDist(dir: string, overrides: Partial<Record<string, string | Buffer | null>> = {}, manifest: Record<string, unknown> = MANIFEST): string {
  const files: Record<string, string | Buffer | null> = {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src/devtools/devtools.html': '<!doctype html><script type="module" src="/assets/devtools.js"></script>',
    'src/devtools/panel/panel.html': '<!doctype html><div id="root"></div><script type="module" src="/assets/panel.js"></script>',
    'assets/devtools.js': 'console.log("relay");',
    'assets/panel.js': `const x="${'a'.repeat(2000)}";export{x};`,
    'assets/panel.css': ':root{--dt-bg:#000}',
    'src/assets/icon-16.png': Buffer.concat([PNG_HEADER, Buffer.alloc(16, 1)]),
    'src/assets/icon-48.png': Buffer.concat([PNG_HEADER, Buffer.alloc(48, 2)]),
    'src/assets/icon-128.png': Buffer.concat([PNG_HEADER, Buffer.alloc(128, 3)]),
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    const full = join(dir, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokenlens-package-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const dist = (name = 'dist', overrides?: Partial<Record<string, string | Buffer | null>>, manifest?: Record<string, unknown>) => writeDist(join(root, name), overrides, manifest);

describe('zip writer and reader', () => {
  it('round-trips every file with the right bytes and sorted entry names', () => {
    const zip = zipDirectory(dist());
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([...entries.map((e) => e.name)].sort());
    expect(entries.map((e) => e.name)).toEqual(listFiles(join(root, 'dist')));
    for (const entry of entries) {
      expect(readZipEntry(zip, entry)).toEqual(readFileSync(join(root, 'dist', ...entry.name.split('/'))));
    }
    expect(entries.some((e) => e.name.includes('\\'))).toBe(false);
  });

  it('stores incompressible data and deflates compressible data', () => {
    const zip = createZip({ 'a.bin': Buffer.from([1, 2, 3]), 'b.txt': Buffer.alloc(4096, 0x41) });
    const [a, b] = readZipEntries(zip);
    expect(a!.method).toBe(0);
    expect(b!.method).toBe(8);
    expect(b!.compressedSize).toBeLessThan(b!.size);
  });

  it('is deterministic: the same tree zipped twice yields identical bytes and checksum', () => {
    const first = zipDirectory(dist('one'));
    const second = zipDirectory(dist('two'));
    expect(first.equals(second)).toBe(true);
    expect(sha256Of(first)).toBe(sha256Of(second));
    expect(readZipEntries(first).every((e) => e.name.length > 0)).toBe(true);
  });

  it('records no timestamps or platform attributes that would vary between builds', () => {
    const zip = createZip({ 'manifest.json': Buffer.from('{}') });
    expect(zip.readUInt16LE(10)).toBe(0x0000);
    expect(zip.readUInt16LE(12)).toBe(0x0021);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(zip.readUInt16LE(central + 4) >> 8).toBe(0);
    expect(zip.readUInt32LE(central + 38)).toBe(0);
  });

  it('rejects data that is not a ZIP, a damaged central directory and a corrupted entry', () => {
    expect(() => readZipEntries(Buffer.from('not a zip at all, definitely not'))).toThrow(/not a ZIP archive/);
    const zip = zipDirectory(dist());
    const damaged = Buffer.from(zip);
    damaged.writeUInt32LE(0xdeadbeef, damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
    expect(() => readZipEntries(damaged)).toThrow(/bad central directory entry/);
    const corrupted = Buffer.from(zip);
    const entries = readZipEntries(corrupted);
    const target = entries.find((e) => e.name === 'assets/panel.css')!;
    const payloadStart = target.localOffset + 30 + Buffer.byteLength(target.name) + corrupted.readUInt16LE(target.localOffset + 28);
    corrupted[payloadStart] = corrupted[payloadStart]! ^ 0xff;
    expect(() => readZipEntry(corrupted, target)).toThrow(/integrity check|corrupt|invalid/i);
  });

  it.runIf(independent)('is readable by an independent ZIP implementation with matching listing and contents', () => {
    const tool = requireZipTool();
    const zipPath = join(root, 'out.zip');
    const zip = zipDirectory(dist());
    writeFileSync(zipPath, zip);
    const result = tool.test(zipPath);
    expect(result.ok, `${tool.name}: ${result.output}`).toBe(true);
    expect(tool.list(zipPath).sort()).toEqual(readZipEntries(zip).map((e) => e.name));
    const extracted = join(root, 'extracted');
    tool.extract(zipPath, extracted);
    for (const file of listFiles(join(root, 'dist'))) {
      expect(readFileSync(join(extracted, ...file.split('/')))).toEqual(readFileSync(join(root, 'dist', ...file.split('/'))));
    }
    expect(listFiles(extracted)).toEqual(listFiles(join(root, 'dist')));
  }, EXTERNAL_TOOL_TIMEOUT_MS);

  it.runIf(independent)('independent tooling also sees the corruption our reader reports', () => {
    const tool = requireZipTool();
    const zip = Buffer.from(zipDirectory(dist()));
    const target = readZipEntries(zip).find((e) => e.name === 'assets/panel.css')!;
    const payloadStart = target.localOffset + 30 + Buffer.byteLength(target.name) + zip.readUInt16LE(target.localOffset + 28);
    zip[payloadStart] = zip[payloadStart]! ^ 0xff;
    const zipPath = join(root, 'corrupt.zip');
    writeFileSync(zipPath, zip);
    expect(tool.test(zipPath).ok).toBe(false);
  }, EXTERNAL_TOOL_TIMEOUT_MS);
});

describe('verifyPackage', () => {
  it('accepts a clean production tree', () => {
    const result = verifyPackage(zipDirectory(dist()), { version: VERSION });
    expect(result.problems).toEqual([]);
    expect(result.entries).toHaveLength(9);
    expect(result.manifest?.version).toBe(VERSION);
  });

  it('requires manifest.json at the archive root', () => {
    const zip = createZip({ 'nested/manifest.json': Buffer.from(JSON.stringify(MANIFEST)), 'assets/panel.js': Buffer.from('1') });
    expect(verifyPackage(zip, { version: VERSION }).problems).toContain('manifest.json is not at the root of the archive');
  });

  it('reports an empty archive and an unreadable manifest', () => {
    expect(verifyPackage(createZip({}), { version: VERSION }).problems).toEqual(['archive is empty', 'manifest.json is not at the root of the archive']);
    const broken = verifyPackage(createZip({ 'manifest.json': Buffer.from('{not json') }), { version: VERSION });
    expect(broken.problems).toEqual([expect.stringMatching(/manifest\.json could not be read/)]);
  });

  it('reports a manifest version that differs from the release version', () => {
    const problems = verifyPackage(zipDirectory(dist()), { version: '9.9.9' }).problems;
    expect(problems).toEqual([`manifest version is ${VERSION}, expected 9.9.9`]);
  });

  it('enforces the extension security posture recorded in the manifest', () => {
    const risky = { ...MANIFEST, manifest_version: 2, permissions: ['tabs'], host_permissions: ['<all_urls>'], background: { service_worker: 'bg.js' }, content_scripts: [{ js: ['cs.js'] }] };
    const problems = verifyPackage(zipDirectory(dist('dist', {}, risky)), { version: VERSION }).problems;
    expect(problems).toEqual(expect.arrayContaining(['manifest_version must be 3', 'permissions must be empty', 'host_permissions must be empty', 'no background worker or content scripts are allowed']));
  });

  it('reports manifest references to files missing from the archive', () => {
    const problems = verifyPackage(zipDirectory(dist('dist', { 'src/assets/icon-48.png': null, 'src/devtools/devtools.html': null })), { version: VERSION }).problems;
    expect(problems).toEqual(expect.arrayContaining(['manifest references missing file src/devtools/devtools.html', 'manifest references missing file src/assets/icon-48.png']));
  });

  it.each([
    ['assets/panel.js.map', 'source map'],
    ['.env', 'environment file'],
    ['node_modules/left-pad/index.js', 'dependency'],
    ['.git/HEAD', 'git metadata'],
    ['src/core/jwt/decoder.ts', 'TypeScript source'],
    ['assets/app.test.js', 'test file'],
    ['test/fixtures/tokens.json', 'test fixture'],
    ['e2e/fixture/app.html', 'E2E fixture'],
    ['docs/release.md', 'documentation'],
    ['coverage/index.html', 'coverage report'],
    ['.DS_Store', 'Finder metadata'],
    ['Thumbs.db', 'Explorer metadata'],
    ['keys/signing.pem', 'private key material'],
    ['secrets/id.p12', 'certificate store'],
  ])('rejects %s (%s)', (path) => {
    const problems = verifyPackage(zipDirectory(dist('dist', { [path]: 'x' })), { version: VERSION }).problems;
    expect(problems).toContain(`development file packaged: ${path}`);
  });

  it('rejects entry paths that could escape the extraction directory', () => {
    const zip = createZip({ 'manifest.json': Buffer.from(JSON.stringify(MANIFEST)), '../evil.js': Buffer.from('1'), '/abs.js': Buffer.from('1'), 'ok/../x.js': Buffer.from('1'), 'win\\style.js': Buffer.from('1') });
    const problems = verifyPackage(zip, { version: VERSION }).problems;
    expect(problems).toEqual(expect.arrayContaining(['unsafe entry path: ../evil.js', 'unsafe entry path: /abs.js', 'unsafe entry path: ok/../x.js', 'unsafe entry path: win\\style.js']));
  });

  it.each([
    ['createMockObservations', 'development seeding'],
    ['synthetic-signature-not-real', 'synthetic fixture signature'],
    ['c3ludGhldGljLXNpZ25hdHVyZS1ub3QtcmVhbA', 'base64url of the synthetic signature'],
    ['-----BEGIN PRIVATE KEY-----', 'PEM key'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS access key id shape'],
    ['ghp_0123456789abcdef', 'GitHub token shape'],
  ])('rejects bundles containing %j (%s)', (needle) => {
    const problems = verifyPackage(zipDirectory(dist('dist', { 'assets/panel.js': `console.log("${needle}")` })), { version: VERSION }).problems;
    expect(problems.some((p) => p.startsWith('assets/panel.js contains forbidden content'))).toBe(true);
  });

  it('rejects JWT-shaped literals in text assets but not in binary assets', () => {
    const jwt = `eyJ${'a'.repeat(30)}.eyJ${'b'.repeat(30)}.${'c'.repeat(30)}`;
    expect(verifyPackage(zipDirectory(dist('a', { 'assets/panel.js': `const t="${jwt}"` })), { version: VERSION }).problems).toContain('assets/panel.js contains a JWT-shaped literal');
    expect(verifyPackage(zipDirectory(dist('b', { 'src/assets/icon-16.png': Buffer.from(jwt) })), { version: VERSION }).problems).toEqual([]);
  });

  it('returns the parse error instead of throwing for data that is not a ZIP', () => {
    const result = verifyPackage(Buffer.from('garbage'.repeat(10)), { version: VERSION });
    expect(result.problems).toEqual([expect.stringMatching(/not a ZIP archive/)]);
    expect(result.entries).toEqual([]);
  });
});

describe('verifyPackageMatchesDist', () => {
  it('passes when the archive holds exactly the dist files', () => {
    expect(verifyPackageMatchesDist(zipDirectory(dist()), join(root, 'dist'))).toEqual([]);
  });

  it('reports missing, extra and modified files', () => {
    const zip = zipDirectory(dist('packaged'));
    const other = dist('other', { 'assets/panel.css': ':root{--dt-bg:#fff}', 'assets/extra.js': '1', 'assets/devtools.js': null });
    expect(verifyPackageMatchesDist(zip, other).sort()).toEqual(
      ['assets/devtools.js is in the archive but not in dist', 'assets/extra.js is in dist but not in the archive', 'assets/panel.css differs between dist and the archive'].sort()
    );
  });

  it('reports a dist directory that does not exist', () => {
    expect(verifyPackageMatchesDist(zipDirectory(dist()), join(root, 'nope'))).toEqual([`${join(root, 'nope')} does not exist`]);
  });
});

describe('buildPackage', () => {
  it('writes the archive, a sha256sum-compatible checksum and provenance, and verifies the result', () => {
    const result = buildPackage({ distDir: dist(), outDir: join(root, 'release'), version: VERSION, env: {} });
    expect(result.problems).toEqual([]);
    expect(result.zipName).toBe(zipNameFor(VERSION));
    expect(existsSync(result.zipPath)).toBe(true);
    expect(readFileSync(result.zipPath).equals(result.zip)).toBe(true);
    expect(sha256Of(readFileSync(result.zipPath))).toBe(result.sha256);
    const checksum = readFileSync(`${result.zipPath}.sha256`, 'utf8');
    expect(checksum).toBe(`${result.sha256}  ${result.zipName}\n`);
    expect(parseChecksumFile(checksum)).toEqual({ sha256: result.sha256, name: result.zipName });
    const provenance = JSON.parse(readFileSync(join(root, 'release', 'provenance.json'), 'utf8'));
    expect(provenance).toEqual(result.provenance);
    expect(provenance).toMatchObject({ name: result.zipName, version: VERSION, sha256: result.sha256, bytes: result.zip.length, entries: 9, commit: null, ref: null, workflowRun: null, repository: null });
    expect(provenance.node).toBe(process.version);
    expect(readdirSync(join(root, 'release')).sort()).toEqual([result.zipName, `${result.zipName}.sha256`, 'provenance.json'].sort());
  });

  it('produces byte-identical archives and checksums for identical trees', () => {
    const a = buildPackage({ distDir: dist('a'), outDir: join(root, 'out-a'), version: VERSION, env: {} });
    const b = buildPackage({ distDir: dist('b'), outDir: join(root, 'out-b'), version: VERSION, env: {} });
    expect(a.sha256).toBe(b.sha256);
    expect(readFileSync(a.zipPath).equals(readFileSync(b.zipPath))).toBe(true);
    expect(readFileSync(`${a.zipPath}.sha256`, 'utf8')).toBe(readFileSync(`${b.zipPath}.sha256`, 'utf8'));
    expect(a.provenance).toEqual(b.provenance);
  });

  it('refuses a directory without a manifest instead of packaging an empty archive', () => {
    mkdirSync(join(root, 'empty'));
    expect(() => buildPackage({ distDir: join(root, 'empty'), outDir: join(root, 'release'), version: VERSION, env: {} })).toThrow(/does not contain manifest\.json; run "npm run build" first/);
    expect(() => buildPackage({ distDir: join(root, 'missing'), outDir: join(root, 'release'), version: VERSION, env: {} })).toThrow(/does not contain manifest\.json/);
    expect(existsSync(join(root, 'release'))).toBe(false);
  });

  it('still writes the files when verification fails so the problem can be inspected', () => {
    const result = buildPackage({ distDir: dist('dist', { 'assets/panel.js.map': '{}' }), outDir: join(root, 'release'), version: VERSION, env: {} });
    expect(result.problems).toEqual(['development file packaged: assets/panel.js.map']);
    expect(existsSync(result.zipPath)).toBe(true);
    expect(statSync(result.zipPath).size).toBe(result.zip.length);
  });

  it('records the GitHub run that built the package when running in Actions, without inventing anything otherwise', () => {
    const env = { GITHUB_SHA: 'abc123', GITHUB_REF: 'refs/heads/main', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/TokenLens', GITHUB_RUN_ID: '42' };
    const provenance = buildProvenance({ zipName: 'TokenLens-v1.2.3.zip', version: VERSION, sha256: 'f'.repeat(64), bytes: 10, entries: 2, env, nodeVersion: 'v24.0.0' });
    expect(provenance).toEqual({
      name: 'TokenLens-v1.2.3.zip',
      version: VERSION,
      sha256: 'f'.repeat(64),
      bytes: 10,
      entries: 2,
      repository: 'owner/TokenLens',
      commit: 'abc123',
      ref: 'refs/heads/main',
      workflowRun: 'https://github.com/owner/TokenLens/actions/runs/42',
      node: 'v24.0.0',
    });
    expect(Object.keys(provenance).join(' ')).not.toMatch(/verified|signed|approved|published/i);
    expect(buildProvenance({ zipName: 'x.zip', version: VERSION, sha256: 'a'.repeat(64), bytes: 1, entries: 1, env: { GITHUB_SHA: 'abc' }, nodeVersion: 'v24' }).workflowRun).toBeNull();
  });
});

describe('parseChecksumFile', () => {
  it('reads sha256sum output in text and binary modes and rejects anything else', () => {
    expect(parseChecksumFile(`${'a'.repeat(64)}  TokenLens-v1.0.0.zip\n`)).toEqual({ sha256: 'a'.repeat(64), name: 'TokenLens-v1.0.0.zip' });
    expect(parseChecksumFile(`${'B'.repeat(64)} *file.zip`)).toEqual({ sha256: 'b'.repeat(64), name: 'file.zip' });
    expect(parseChecksumFile('not a checksum')).toBeNull();
    expect(parseChecksumFile(`${'a'.repeat(63)}  short.zip`)).toBeNull();
  });
});
