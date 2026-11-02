import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipDirectory } from '../../../scripts/release/zip.mjs';
import { buildProvenance, sha256Of, zipNameFor } from '../../../scripts/release/lib/package.mjs';

/**
 * The retry CLIs are what the Retry workflow runs. They are exercised as real processes against a
 * local HTTP server that plays GitHub and the Chrome Web Store, so the exit codes, GitHub outputs
 * and summaries the workflow depends on are tested without any network access. The processes are
 * spawned asynchronously because the fake server lives in this test's event loop.
 */
const REPO = resolve(__dirname, '../../..');
const SCRIPTS = join(REPO, 'scripts', 'release');
const VERSION = '1.2.3';
const ZIP_NAME = zipNameFor(VERSION);
const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const PUBLISHER = 'pub-synthetic';
const GITHUB_TOKEN = 'ghs_synthetic-github-token';
const CWS_TOKEN = 'ya29.synthetic-store-token';
const snapshotRepoVersions = () => ['manifest.json', 'package.json', 'package-lock.json'].map((f) => readFileSync(join(REPO, f), 'utf8'));

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  summary: string;
}

function run(script: string, args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  const outputFile = join(cwd, `output-${Math.random().toString(36).slice(2)}.txt`);
  const summaryFile = join(cwd, `summary-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(SCRIPTS, script), ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      const outputs = Object.fromEntries(
        readFileSync(outputFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string])
      );
      done({ status, stdout, stderr, outputs, summary: readFileSync(summaryFile, 'utf8') });
    });
  });
}

/** Release fixture: a real package built with the project's ZIP writer plus checksum and provenance. */
let fixtureDir: string;
let zip: Buffer;
let checksumText: string;
let provenance: Record<string, unknown>;
beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'tokenlens-retry-fixture-'));
  const dist = join(fixtureDir, 'dist');
  const files: Record<string, string | Buffer> = {
    'manifest.json': `${JSON.stringify({ manifest_version: 3, name: 'TokenLens', version: VERSION, devtools_page: 'src/devtools/devtools.html', permissions: [], icons: { '16': 'icon-16.png' } }, null, 2)}\n`,
    'src/devtools/devtools.html': '<!doctype html><title>relay</title>',
    'icon-16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    'assets/panel.js': 'export const panel = 1;',
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(dist, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  zip = zipDirectory(dist);
  checksumText = `${sha256Of(zip)}  ${ZIP_NAME}\n`;
  provenance = buildProvenance({ zipName: ZIP_NAME, version: VERSION, sha256: sha256Of(zip), bytes: zip.length, entries: 4, env: { GITHUB_REPOSITORY: 'owner/TokenLens', GITHUB_SHA: 'c'.repeat(40) }, nodeVersion: 'v24.0.0' });
});
afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** One local server plays both APIs; each test configures its behaviour and inspects the calls. */
interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  body: Buffer;
}
let server: Server;
let base: string;
let handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
const recorded: Recorded[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      recorded.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no port');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const bytes = (res: ServerResponse, body: Buffer | string) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(body);
};

function githubHandler(options: { release?: Record<string, unknown> | null; checksum?: string; provenanceText?: string | null } = {}) {
  const assets = [
    { name: ZIP_NAME, url: `${base}/assets/1`, size: zip.length },
    { name: `${ZIP_NAME}.sha256`, url: `${base}/assets/2` },
    ...(options.provenanceText === null ? [] : [{ name: 'provenance.json', url: `${base}/assets/3` }]),
  ];
  const release = options.release === undefined ? { tag_name: `v${VERSION}`, draft: false, html_url: 'https://github.com/owner/TokenLens/releases/tag/v1.2.3', target_commitish: 'c'.repeat(40), assets } : options.release;
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === `/repos/owner/TokenLens/releases/tags/v${VERSION}`) return release ? json(res, 200, release) : json(res, 404, { message: 'Not Found' });
    if (req.url === '/assets/1') return bytes(res, zip);
    if (req.url === '/assets/2') return bytes(res, options.checksum ?? checksumText);
    if (req.url === '/assets/3') return bytes(res, options.provenanceText ?? JSON.stringify(provenance));
    return json(res, 404, { message: `unexpected ${req.url}` });
  };
}

vi.setConfig({ testTimeout: 60_000 });

let work: string;
let before: string[];
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'tokenlens-retry-cli-'));
  before = snapshotRepoVersions();
  recorded.length = 0;
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  expect(snapshotRepoVersions()).toEqual(before);
});

describe('check-inputs.mjs', () => {
  const check = (githubRelease: string, store: string, extra: string[] = []) => run('check-inputs.mjs', ['--github-release', githubRelease, '--store', store, ...extra], {}, work);

  it('accepts the dry run and every real release, writing the mode', async () => {
    expect(await check('false', 'none')).toMatchObject({ status: 0, outputs: { mode: 'dry-run' } });
    for (const store of ['upload-only', 'submit-for-review', 'submit-staged']) {
      const result = await check('true', store);
      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs.mode).toBe('release');
      expect(result.summary).not.toMatch(/publicly available/);
    }
  });

  it('rejects a real release without a store action and a store action without a release', async () => {
    const noStore = await check('true', 'none');
    expect(noStore.status).toBe(1);
    expect(noStore.stderr).toMatch(/::error::a real release must schedule the Chrome Web Store step/);
    expect(noStore.outputs.mode).toBeUndefined();
    const noRelease = await check('false', 'submit-for-review');
    expect(noRelease.status).toBe(1);
    expect(noRelease.stderr).toMatch(/::error::store=submit-for-review requires github_release=true/);
  });

  it('requires a reason for the non-monotonic override', async () => {
    expect((await check('false', 'none', ['--allow-non-monotonic', 'true'])).stderr).toMatch(/needs a reason/);
    const ok = await check('false', 'none', ['--allow-non-monotonic', 'true', '--reason', 'synthetic']);
    expect(ok.status).toBe(0);
    expect(ok.summary).toContain('Non-monotonic version override requested: synthetic');
  });
});

describe('fetch-release.mjs', () => {
  const fetchRelease = (env: Record<string, string> = {}) => run('fetch-release.mjs', ['--version', VERSION, '--repository', 'owner/TokenLens', '--out', join(work, 'release'), '--api-base', base], { GITHUB_TOKEN, ...env }, work);

  it('downloads, verifies and writes the released package with its checksum and provenance', async () => {
    handler = githubHandler();
    const result = await fetchRelease();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(work, 'release', ZIP_NAME)).equals(zip)).toBe(true);
    expect(readFileSync(join(work, 'release', `${ZIP_NAME}.sha256`), 'utf8')).toBe(checksumText);
    expect(JSON.parse(readFileSync(join(work, 'release', 'provenance.json'), 'utf8'))).toEqual(provenance);
    expect(result.outputs).toMatchObject({ tag: `v${VERSION}`, zip_name: ZIP_NAME, sha256: sha256Of(zip), release_url: 'https://github.com/owner/TokenLens/releases/tag/v1.2.3' });
    expect(result.summary).toMatch(/Reusing the released package .*nothing was rebuilt/);
    expect(recorded.every((r) => r.authorization === `Bearer ${GITHUB_TOKEN}`)).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(GITHUB_TOKEN);
  });

  it('fails without writing anything when the release is missing, and says a retry is pointless', async () => {
    handler = githubHandler({ release: null });
    const result = await fetchRelease();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/::error::no GitHub Release exists for tag v1\.2\.3/);
    expect(result.outputs.retry_safe).toBe('false');
    expect(existsSync(join(work, 'release'))).toBe(false);
  });

  it('fails on a corrupted checksum or provenance without keeping the download', async () => {
    handler = githubHandler({ checksum: `${'0'.repeat(64)}  ${ZIP_NAME}\n` });
    const checksum = await fetchRelease();
    expect(checksum.status).toBe(1);
    expect(checksum.stderr).toMatch(/SHA-256 mismatch/);
    expect(existsSync(join(work, 'release'))).toBe(false);

    handler = githubHandler({ provenanceText: JSON.stringify({ ...provenance, sha256: '1'.repeat(64) }) });
    const prov = await fetchRelease();
    expect(prov.status).toBe(1);
    expect(prov.stderr).toMatch(/provenance\.json records SHA-256/);
  });

  it('reports a rejected token and transient failures with the right retry hint', async () => {
    handler = (_req, res) => json(res, 401, { message: 'Bad credentials' });
    const denied = await fetchRelease();
    expect(denied.status).toBe(1);
    expect(denied.outputs.retry_safe).toBe('false');
    expect(denied.stderr).toMatch(/HTTP 401/);
    expect(denied.stderr).not.toContain(GITHUB_TOKEN);

    handler = (_req, res) => json(res, 503, { message: 'unavailable' });
    const transient = await fetchRelease();
    expect(transient.status).toBe(1);
    expect(transient.outputs.retry_safe).toBe('true');
    expect(transient.summary).toMatch(/Re-running later may succeed/);
  });

  it('exits 2 on malformed usage', async () => {
    expect((await run('fetch-release.mjs', ['--version', 'v1', '--repository', 'owner/TokenLens'], { GITHUB_TOKEN }, work)).status).toBe(2);
  });
});

describe('cws-recover.mjs', () => {
  interface StoreState { published?: string; submitted?: { state: string; version: string }; lastUpload?: string; uploadResponse?: Record<string, unknown>; publishStatus?: number }
  function storeHandler(state: StoreState) {
    return (req: IncomingMessage, res: ServerResponse) => {
      if (req.headers.authorization !== `Bearer ${CWS_TOKEN}`) return json(res, 401, { error: { message: 'bad token' } });
      if (req.url === `/v2/publishers/${PUBLISHER}/items/${ITEM}:fetchStatus`) {
        return json(res, 200, {
          name: `publishers/${PUBLISHER}/items/${ITEM}`,
          itemId: ITEM,
          ...(state.published ? { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: state.published }] } } : {}),
          ...(state.submitted ? { submittedItemRevisionStatus: { state: state.submitted.state, distributionChannels: [{ crxVersion: state.submitted.version }] } } : {}),
          ...(state.lastUpload ? { lastAsyncUploadState: state.lastUpload } : {}),
        });
      }
      if (req.url === `/upload/v2/publishers/${PUBLISHER}/items/${ITEM}:upload`) {
        state.lastUpload = 'SUCCEEDED';
        return json(res, 200, state.uploadResponse ?? { itemId: ITEM, crxVersion: VERSION, uploadState: 'SUCCEEDED' });
      }
      if (req.url === `/v2/publishers/${PUBLISHER}/items/${ITEM}:publish`) {
        if (state.publishStatus) return json(res, state.publishStatus, { error: { message: 'synthetic failure' } });
        state.submitted = { state: 'PENDING_REVIEW', version: VERSION };
        return json(res, 200, { itemId: ITEM, state: 'PENDING_REVIEW' });
      }
      return json(res, 404, { error: { message: `unexpected ${req.url}` } });
    };
  }
  const recover = (action: string, replaceDraft: string, env: Record<string, string> = { CWS_ACCESS_TOKEN: CWS_TOKEN }) => {
    const zipPath = join(work, ZIP_NAME);
    writeFileSync(zipPath, zip);
    return run('cws-recover.mjs', ['--publisher', PUBLISHER, '--item', ITEM, '--zip', zipPath, '--expect-version', VERSION, '--action', action, '--replace-draft', replaceDraft, '--api-base', base], env, work);
  };
  const posts = () => recorded.filter((r) => r.method === 'POST').map((r) => r.url.split(':').pop());

  it('uploads and submits a version the store has never seen, then reports in-review on a duplicate run', async () => {
    const state: StoreState = {};
    handler = storeHandler(state);
    const first = await recover('submit-for-review', 'true');
    expect(first.status, first.stderr).toBe(0);
    expect(first.outputs).toMatchObject({ outcome: 'submitted', mutated: 'true', retry_safe: 'true' });
    expect(posts()).toEqual(['upload', 'publish']);
    expect(recorded.find((r) => r.method === 'POST')!.body.equals(zip)).toBe(true);
    expect(first.summary).toMatch(/Submission accepted: version 1\.2\.3 is in Google's review queue\. Acceptance is not approval/);
    expect(first.stdout + first.stderr).not.toContain(CWS_TOKEN);

    recorded.length = 0;
    const second = await recover('submit-for-review', 'true');
    expect(second.status).toBe(0);
    expect(second.outputs).toMatchObject({ outcome: 'in-review', mutated: 'false' });
    expect(posts()).toEqual([]);
  });

  it('upload-only uploads without submitting and accepts the workflow action names', async () => {
    handler = storeHandler({ lastUpload: 'FAILED' });
    const result = await recover('upload-only', 'true');
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs.outcome).toBe('uploaded');
    expect(posts()).toEqual(['upload']);
    expect(result.summary).toMatch(/has not been submitted/);
  });

  it('refuses to upload without the draft acknowledgement and performs no mutation', async () => {
    handler = storeHandler({ lastUpload: 'SUCCEEDED' });
    const result = await recover('submit-for-review', 'false');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Re-run with replace_draft enabled/);
    expect(result.outputs).toMatchObject({ outcome: 'failed', retry_safe: 'false' });
    expect(posts()).toEqual([]);
  });

  it('exits successfully without touching a store that already publishes the version', async () => {
    handler = storeHandler({ published: VERSION });
    const result = await recover('submit-for-review', 'false');
    expect(result.status).toBe(0);
    expect(result.outputs).toMatchObject({ outcome: 'published', mutated: 'false' });
    expect(posts()).toEqual([]);
    expect(result.summary).toMatch(/Already published.*nothing was changed/);
  });

  it('stops on a conflicting submitted version with manual instructions', async () => {
    handler = storeHandler({ submitted: { state: 'PENDING_REVIEW', version: '1.2.4' } });
    const result = await recover('submit-for-review', 'true');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/version 1\.2\.4 is already submitted/);
    expect(result.outputs.retry_safe).toBe('false');
    expect(result.summary).toMatch(/manual intervention/);
    expect(posts()).toEqual([]);
  });

  it('marks a failed publish after a successful upload as retryable when the store errored', async () => {
    handler = storeHandler({ publishStatus: 503 });
    const result = await recover('submit-staged', 'true');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/HTTP 503/);
    expect(result.outputs).toMatchObject({ outcome: 'failed', retry_safe: 'true' });
    expect(posts()).toEqual(['upload', 'publish']);
  });

  it('fails before any request on a missing token, an unknown action or a missing package', async () => {
    handler = storeHandler({});
    expect((await recover('submit-for-review', 'true', {})).stderr).toMatch(/CWS_ACCESS_TOKEN is not set/);
    expect((await recover('none', 'true')).stderr).toMatch(/unknown --action "none"/);
    const missing = await run('cws-recover.mjs', ['--publisher', PUBLISHER, '--item', ITEM, '--zip', join(work, 'nope.zip'), '--expect-version', VERSION, '--action', 'upload-only'], { CWS_ACCESS_TOKEN: CWS_TOKEN }, work);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/cannot read/);
    expect(recorded).toHaveLength(0);
  });
});

describe('cws-publish.mjs', () => {
  it('rejects unknown actions and accepts the workflow action names before any network call', async () => {
    const zipPath = join(work, ZIP_NAME);
    writeFileSync(zipPath, zip);
    const unknown = await run('cws-publish.mjs', ['--publisher', PUBLISHER, '--item', ITEM, '--zip', zipPath, '--expect-version', VERSION, '--action', 'publish-now'], { CWS_ACCESS_TOKEN: CWS_TOKEN }, work);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/unknown --action "publish-now"/);
    expect(unknown.outputs).toMatchObject({ outcome: 'failed', retry_safe: 'false' });
    // A missing token is caught before the store is contacted, so the workflow action name is
    // accepted without any request leaving the process.
    const noToken = await run('cws-publish.mjs', ['--publisher', PUBLISHER, '--item', ITEM, '--zip', zipPath, '--expect-version', VERSION, '--action', 'submit-for-review'], {}, work);
    expect(noToken.status).toBe(1);
    expect(noToken.stderr).toMatch(/CWS_ACCESS_TOKEN is not set/);
    expect(recorded).toHaveLength(0);
  });
});
