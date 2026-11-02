import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipDirectory } from '../../../scripts/release/zip.mjs';
import { buildProvenance, sha256Of, validateProvenance, zipNameFor } from '../../../scripts/release/lib/package.mjs';
import { downloadAsset, fetchRelease, fetchVerifiedReleasePackage, GITHUB_API, ReleaseError, selectReleaseAssets, verifyReleaseAssets } from '../../../scripts/release/lib/github-release.mjs';

const REPO = 'owner/TokenLens';
const TOKEN = 'ghs_synthetic-github-token-never-logged';
const VERSION = '1.2.3';
const TAG = `v${VERSION}`;
const ZIP_NAME = zipNameFor(VERSION);
const COMMIT = 'a'.repeat(40);
const RELEASE_URL = `${GITHUB_API}/repos/${REPO}/releases/tags/${TAG}`;
const assetUrl = (id: number) => `${GITHUB_API}/repos/${REPO}/releases/assets/${id}`;

/** A real, verifiable package built with the project's own ZIP writer. */
let zip: Buffer;
let checksumText: string;
let provenance: Record<string, unknown>;
let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'tokenlens-release-fixture-'));
  const dist = join(work, 'dist');
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
  provenance = buildProvenance({
    zipName: ZIP_NAME,
    version: VERSION,
    sha256: sha256Of(zip),
    bytes: zip.length,
    entries: 4,
    env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '42', GITHUB_SHA: COMMIT, GITHUB_REF: 'refs/heads/main' },
    nodeVersion: 'v24.0.0',
  });
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}
interface ReplyValue { status?: number; body?: unknown; bytes?: Buffer; text?: string }

/** Replies keyed by URL so the parallel asset downloads are order-independent. */
function routedFetch(routes: Record<string, ReplyValue | (() => ReplyValue)>, options: { fail?: Error } = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {} });
    if (options.fail) return Promise.reject(options.fail);
    const route = routes[url];
    if (!route) return Promise.resolve(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
    const reply = typeof route === 'function' ? route() : route;
    const body: BodyInit = reply.bytes ? new Uint8Array(reply.bytes) : (reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
    return Promise.resolve(new Response(body, { status: reply.status ?? 200 }));
  };
  return { fetch, calls };
}

function releaseJson(overrides: Record<string, unknown> = {}, assets?: { name: string; id: number; size?: number }[]) {
  const list = assets ?? [
    { name: ZIP_NAME, id: 1, size: zip.length },
    { name: `${ZIP_NAME}.sha256`, id: 2 },
    { name: 'provenance.json', id: 3 },
  ];
  return { tag_name: TAG, draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/${TAG}`, target_commitish: COMMIT, assets: list.map((a) => ({ ...a, url: assetUrl(a.id) })), ...overrides };
}

function routes(release: Record<string, unknown> = releaseJson(), overrides: Record<string, ReplyValue> = {}) {
  return {
    [RELEASE_URL]: { body: release },
    [assetUrl(1)]: { bytes: zip },
    [assetUrl(2)]: { text: checksumText },
    [assetUrl(3)]: { text: JSON.stringify(provenance) },
    ...overrides,
  };
}

const run = (net: { fetch: typeof globalThis.fetch }, logs: string[] = []) => fetchVerifiedReleasePackage({ repository: REPO, version: VERSION, token: TOKEN }, { fetch: net.fetch, log: (l) => logs.push(l) });
const failure = async (promise: Promise<unknown>): Promise<ReleaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReleaseError) return error;
    throw error;
  }
  throw new Error('expected a ReleaseError');
};
const notLeaked = (error: Error, logs: string[] = []) => {
  expect(error.message).not.toContain(TOKEN);
  for (const line of logs) expect(line).not.toContain(TOKEN);
};

describe('fetchVerifiedReleasePackage: the GitHub Release is the source of truth', () => {
  it('downloads the package, checksum and provenance with the token and returns the verified bytes', async () => {
    const net = routedFetch(routes());
    const logs: string[] = [];
    const result = await run(net, logs);
    expect(result.tag).toBe(TAG);
    expect(result.zipName).toBe(ZIP_NAME);
    expect(result.zip.equals(zip)).toBe(true);
    expect(result.sha256).toBe(sha256Of(zip));
    expect(result.provenance).toEqual(provenance);
    expect(result.entries).toHaveLength(4);
    expect(result.releaseUrl).toBe(`https://github.com/${REPO}/releases/tag/${TAG}`);
    const release = net.calls.find((c) => c.url === RELEASE_URL)!;
    expect(release.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(release.headers.Accept).toBe('application/vnd.github+json');
    const asset = net.calls.find((c) => c.url === assetUrl(1))!;
    expect(asset.headers.Accept).toBe('application/octet-stream');
    expect(asset.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(logs).toEqual([expect.stringMatching(/^Found GitHub Release v1\.2\.3/), expect.stringMatching(/^Downloaded TokenLens-v1\.2\.3\.zip .* and provenance\.json/), expect.stringMatching(/^Verified TokenLens-v1\.2\.3\.zip: SHA-256 [0-9a-f]{64}, 4 files, manifest version 1\.2\.3, provenance consistent/)]);
    for (const line of logs) expect(line).not.toContain(TOKEN);
  });

  it('accepts a release without provenance.json and says so', async () => {
    const net = routedFetch(routes(releaseJson({}, [{ name: ZIP_NAME, id: 1 }, { name: `${ZIP_NAME}.sha256`, id: 2 }])));
    const logs: string[] = [];
    const result = await run(net, logs);
    expect(result.provenance).toBeNull();
    expect(logs.at(-1)).toMatch(/no provenance\.json attached/);
  });

  it('fails when there is no GitHub Release for the version (nothing to retry)', async () => {
    const net = routedFetch({});
    const error = await failure(run(net));
    expect(error.stage).toBe('release');
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/no GitHub Release exists for tag v1\.2\.3 in owner\/TokenLens.*run the Release workflow instead/);
    expect(net.calls).toHaveLength(1);
    notLeaked(error);
  });

  it('fails on a draft release and on a release for a different tag', async () => {
    expect((await failure(run(routedFetch(routes(releaseJson({ draft: true })))))).message).toMatch(/still a draft/);
    expect((await failure(run(routedFetch(routes(releaseJson({ tag_name: 'v9.9.9' })))))).message).toMatch(/returned a release for v9\.9\.9, expected v1\.2\.3/);
  });

  it('fails when the release lacks the package or its checksum, listing what is there', async () => {
    const noZip = await failure(run(routedFetch(routes(releaseJson({}, [{ name: `${ZIP_NAME}.sha256`, id: 2 }, { name: 'notes.txt', id: 9 }])))));
    expect(noZip.stage).toBe('assets');
    expect(noZip.message).toMatch(/does not carry TokenLens-v1\.2\.3\.zip \(assets: TokenLens-v1\.2\.3\.zip\.sha256, notes\.txt\)/);
    const noChecksum = await failure(run(routedFetch(routes(releaseJson({}, [{ name: ZIP_NAME, id: 1 }])))));
    expect(noChecksum.message).toMatch(/does not carry TokenLens-v1\.2\.3\.zip\.sha256/);
    const nothing = await failure(run(routedFetch(routes(releaseJson({ assets: [] })))));
    expect(nothing.message).toMatch(/does not carry TokenLens-v1\.2\.3\.zip and TokenLens-v1\.2\.3\.zip\.sha256 \(assets: none\)/);
  });

  it('rejects a checksum mismatch', async () => {
    const net = routedFetch(routes(releaseJson(), { [assetUrl(2)]: { text: `${'0'.repeat(64)}  ${ZIP_NAME}\n` } }));
    const error = await failure(run(net));
    expect(error.stage).toBe('verify');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/SHA-256 mismatch/);
  });

  it('rejects a checksum file that names another package or is not a checksum file', async () => {
    expect((await failure(run(routedFetch(routes(releaseJson(), { [assetUrl(2)]: { text: `${sha256Of(zip)}  other.zip\n` } }))))).message).toMatch(/names other\.zip, expected TokenLens-v1\.2\.3\.zip/);
    expect((await failure(run(routedFetch(routes(releaseJson(), { [assetUrl(2)]: { text: 'garbage' } }))))).message).toMatch(/not a sha256sum checksum file/);
  });

  it('rejects an invalid ZIP even when its checksum file agrees with it', async () => {
    const bogus = Buffer.from('this is not a zip archive at all');
    const net = routedFetch(routes(releaseJson({}, [{ name: ZIP_NAME, id: 1 }, { name: `${ZIP_NAME}.sha256`, id: 2 }]), { [assetUrl(1)]: { bytes: bogus }, [assetUrl(2)]: { text: `${sha256Of(bogus)}  ${ZIP_NAME}\n` } }));
    const error = await failure(run(net));
    expect(error.stage).toBe('verify');
    expect(error.message).toMatch(/failed verification/);
  });

  it('rejects a package whose manifest version is not the released version', async () => {
    const net = routedFetch(routes());
    const error = await failure(fetchVerifiedReleasePackage({ repository: REPO, version: '1.2.4', token: TOKEN }, { fetch: net.fetch }));
    // No release exists for 1.2.4 in the routes, so the lookup fails first; emulate a mislabelled release instead.
    expect(error.stage).toBe('release');
    const mislabelled = routedFetch({ ...routes(releaseJson({ tag_name: 'v1.2.4' }, [{ name: 'TokenLens-v1.2.4.zip', id: 1 }, { name: 'TokenLens-v1.2.4.zip.sha256', id: 2 }])), [`${GITHUB_API}/repos/${REPO}/releases/tags/v1.2.4`]: { body: releaseJson({ tag_name: 'v1.2.4' }, [{ name: 'TokenLens-v1.2.4.zip', id: 1 }, { name: 'TokenLens-v1.2.4.zip.sha256', id: 2 }]) }, [assetUrl(2)]: { text: `${sha256Of(zip)}  TokenLens-v1.2.4.zip\n` } });
    const versionError = await failure(fetchVerifiedReleasePackage({ repository: REPO, version: '1.2.4', token: TOKEN }, { fetch: mislabelled.fetch }));
    expect(versionError.message).toMatch(/manifest version is 1\.2\.3, expected 1\.2\.4/);
  });

  it('rejects invalid provenance: wrong schema, wrong checksum, wrong commit, not JSON', async () => {
    const withProvenance = (p: unknown, release = releaseJson()) => routedFetch(routes(release, { [assetUrl(3)]: { text: typeof p === 'string' ? p : JSON.stringify(p) } }));
    expect((await failure(run(withProvenance({ ...provenance, sha256: '0'.repeat(64) })))).message).toMatch(/provenance\.json records SHA-256 0{64}/);
    expect((await failure(run(withProvenance({ ...provenance, extra: true })))).message).toMatch(/unexpected field "extra"/);
    const { node: _node, ...missingNode } = provenance;
    expect((await failure(run(withProvenance(missingNode)))).message).toMatch(/missing "node"/);
    expect((await failure(run(withProvenance({ ...provenance, commit: 'b'.repeat(40) })))).message).toMatch(/records commit b{40} but the release points at a{40}/);
    expect((await failure(run(withProvenance([1, 2, 3])))).message).toMatch(/not a JSON object/);
    expect((await failure(run(withProvenance('{not json')))).message).toMatch(/not valid JSON/);
  });

  it('maps GitHub failures to actionable, correctly classified errors', async () => {
    for (const [code, retryable, pattern] of [
      [401, false, /GitHub token was rejected/],
      [403, false, /contents: read/],
      [429, true, /rate-limited/],
      [500, true, /server error/],
      [503, true, /server error/],
    ] as const) {
      const net = routedFetch({ [RELEASE_URL]: { status: code, body: { message: 'synthetic' } } });
      const error = await failure(run(net));
      expect(error.status).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toMatch(pattern);
      notLeaked(error);
    }
  });

  it('treats network failures as retryable and a short download as incomplete', async () => {
    const offline = routedFetch({}, { fail: new Error('getaddrinfo ENOTFOUND api.github.com') });
    const network = await failure(run(offline));
    expect(network.retryable).toBe(true);
    expect(network.message).toMatch(/could not reach GitHub: getaddrinfo ENOTFOUND/);
    notLeaked(network);

    const truncated = routedFetch(routes(releaseJson(), { [assetUrl(1)]: { bytes: zip.subarray(0, 10) } }));
    const short = await failure(run(truncated));
    expect(short.stage).toBe('download');
    expect(short.retryable).toBe(true);
    expect(short.message).toMatch(/is 10 bytes but the release lists/);

    const denied = routedFetch(routes(releaseJson(), { [assetUrl(1)]: { status: 403, text: 'forbidden' } }));
    expect((await failure(run(denied))).message).toMatch(/downloading TokenLens-v1\.2\.3\.zip failed with HTTP 403/);
  });

  it('validates its inputs before contacting GitHub', async () => {
    const net = routedFetch(routes());
    expect((await failure(fetchVerifiedReleasePackage({ repository: 'not a repo', version: VERSION, token: TOKEN }, { fetch: net.fetch }))).message).toMatch(/not an owner\/name repository/);
    expect((await failure(fetchVerifiedReleasePackage({ repository: REPO, version: VERSION, token: '' }, { fetch: net.fetch }))).message).toMatch(/GITHUB_TOKEN is not set/);
    expect((await failure(fetchVerifiedReleasePackage({ repository: REPO, version: 'v1.2.3', token: TOKEN }, { fetch: net.fetch }))).message).toMatch(/not a release version/);
    expect(net.calls).toHaveLength(0);
  });
});

describe('release asset helpers', () => {
  it('selectReleaseAssets ignores malformed entries and finds assets by exact name', () => {
    const release = { assets: [{ name: 'junk' }, null, { name: ZIP_NAME, url: 'u1', size: 5 }, { name: `${ZIP_NAME}.sha256`, url: 'u2' }] };
    const selected = selectReleaseAssets(release, VERSION);
    expect(selected.zip).toEqual({ name: ZIP_NAME, url: 'u1', size: 5 });
    expect(selected.provenance).toBeNull();
    expect(selected.zipName).toBe(ZIP_NAME);
  });

  it('verifyReleaseAssets and validateProvenance report every inconsistency', () => {
    const ok = verifyReleaseAssets({ version: VERSION, zipName: ZIP_NAME, zip, checksumText, provenance, releaseCommit: COMMIT });
    expect(ok.problems).toEqual([]);
    expect(ok.sha256).toBe(sha256Of(zip));
    const bad = verifyReleaseAssets({ version: VERSION, zipName: ZIP_NAME, zip, checksumText, provenance: { ...provenance, bytes: 1, entries: 99, version: '0.0.1', name: 'TokenLens-v0.0.1.zip' } });
    expect(bad.problems).toEqual([
      expect.stringMatching(/describes TokenLens-v0\.0\.1\.zip/),
      expect.stringMatching(/records version 0\.0\.1/),
      expect.stringMatching(/records 1 bytes/),
      expect.stringMatching(/records 99 entries/),
    ]);
    expect(validateProvenance({ ...provenance, workflowRun: 'ftp://nope' }, { version: VERSION, zipName: ZIP_NAME, sha256: sha256Of(zip), bytes: zip.length })).toEqual([expect.stringMatching(/invalid "workflowRun"/)]);
    expect(validateProvenance({ ...provenance, repository: null, commit: null, ref: null, workflowRun: null }, { version: VERSION, zipName: ZIP_NAME, sha256: sha256Of(zip), bytes: zip.length })).toEqual([]);
  });

  it('fetchRelease and downloadAsset use the injected API base and never retry on their own', async () => {
    const net = routedFetch({ 'https://ghe.example.test/api/v3/repos/owner/TokenLens/releases/tags/v1.2.3': { body: releaseJson() } });
    const release = await fetchRelease({ repository: REPO, tag: TAG, token: TOKEN }, { fetch: net.fetch, apiBase: 'https://ghe.example.test/api/v3' });
    expect(release.tag_name).toBe(TAG);
    expect(net.calls).toHaveLength(1);
    const bytes = await downloadAsset({ name: 'x', url: assetUrl(1) }, { token: TOKEN }, { fetch: routedFetch({ [assetUrl(1)]: { bytes: zip } }).fetch });
    expect(bytes.equals(zip)).toBe(true);
  });
});
