/**
 * Reads an existing GitHub Release and its assets so a retry can reuse exactly the package that
 * was released. Nothing here builds, tags or publishes; the release is the source of truth.
 *
 * Endpoints (https://docs.github.com/rest/releases):
 *   GET /repos/{owner}/{repo}/releases/tags/{tag}       release metadata and asset list
 *   GET {asset.url}  with Accept: application/octet-stream   asset bytes
 *
 * HTTP and logging are injected so the flow is tested without GitHub.
 */
import { parseChecksumFile, sha256Of, validateProvenance, verifyPackage, zipNameFor } from './package.mjs';
import { VERSION_PATTERN } from './version.mjs';

export const GITHUB_API = 'https://api.github.com';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** A failed release lookup or verification. Never carries the token. */
export class ReleaseError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, stage: 'input' | 'release' | 'assets' | 'download' | 'verify', retryable?: boolean }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'ReleaseError';
    this.status = info.status;
    this.stage = info.stage;
    this.retryable = info.retryable ?? (info.status !== undefined && RETRYABLE_STATUS.has(info.status));
  }
}

/**
 * @typedef {object} ReleaseAsset
 * @property {string} name
 * @property {string} url API url of the asset
 * @property {number} [size]
 */

/**
 * @typedef {object} ReleaseDeps
 * @property {typeof fetch} fetch
 * @property {string} [apiBase]
 * @property {(line: string) => void} [log]
 */

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} method
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {typeof fetch} fetch
 * @param {'release' | 'download'} stage
 */
async function request(method, url, headers, fetch, stage) {
  try {
    return await fetch(url, { method, headers });
  } catch (error) {
    throw new ReleaseError(`${method} ${url} could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`, { stage, retryable: true });
  }
}

/**
 * @param {number} status
 * @param {string} what
 */
function describeHttpFailure(status, what) {
  switch (status) {
    case 401:
      return `${what} failed with HTTP 401: the GitHub token was rejected.`;
    case 403:
      return `${what} failed with HTTP 403: the GitHub token may not read releases of this repository (the job needs contents: read) or the API rate limit was hit.`;
    case 429:
      return `${what} failed with HTTP 429: GitHub rate-limited the request; re-run later.`;
    default:
      return status >= 500 ? `${what} failed with HTTP ${status}: GitHub reported a server error; re-run later.` : `${what} failed with HTTP ${status}.`;
  }
}

/**
 * Fetches the release for `tag` and checks that it is a real, published release of that tag.
 * @param {{ repository: string, tag: string, token: string }} input `repository` is `owner/name`
 * @param {ReleaseDeps} deps
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchRelease({ repository, tag, token }, deps) {
  const { fetch, apiBase = GITHUB_API } = deps;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new ReleaseError(`"${repository}" is not an owner/name repository`, { stage: 'input', retryable: false });
  if (!token) throw new ReleaseError('no GitHub token: GITHUB_TOKEN is not set', { stage: 'input', retryable: false });
  const url = `${apiBase}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await request('GET', url, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, fetch, 'release');
  if (response.status === 404) {
    throw new ReleaseError(`no GitHub Release exists for tag ${tag} in ${repository}. The Release workflow has not published this version, so there is nothing to retry; run the Release workflow instead.`, { status: 404, stage: 'release', retryable: false });
  }
  if (!response.ok) throw new ReleaseError(describeHttpFailure(response.status, `GET ${url}`), { status: response.status, stage: 'release' });
  /** @type {unknown} */
  let release;
  try {
    release = await response.json();
  } catch {
    throw new ReleaseError(`GET ${url} returned a body that is not JSON`, { stage: 'release', retryable: false });
  }
  if (!isRecord(release) || release.tag_name !== tag) {
    throw new ReleaseError(`GET ${url} returned a release for ${isRecord(release) ? String(release.tag_name) : 'nothing'}, expected ${tag}`, { stage: 'release', retryable: false });
  }
  if (release.draft === true) {
    throw new ReleaseError(`the GitHub Release for ${tag} is still a draft; the Release workflow did not finish publishing it. Publish or delete the draft release before retrying the store.`, { stage: 'release', retryable: false });
  }
  return release;
}

/**
 * Picks the package, checksum and provenance assets of a release by their canonical names.
 * @param {Record<string, any>} release
 * @param {string} version
 * @returns {{ zip: ReleaseAsset, checksum: ReleaseAsset, provenance: ReleaseAsset | null, zipName: string }}
 */
export function selectReleaseAssets(release, version) {
  const zipName = zipNameFor(version);
  /** @type {ReleaseAsset[]} */
  const assets = Array.isArray(release.assets) ? release.assets.filter((a) => isRecord(a) && typeof a.name === 'string' && typeof a.url === 'string') : [];
  const byName = (name) => assets.find((a) => a.name === name) ?? null;
  const zip = byName(zipName);
  const checksum = byName(`${zipName}.sha256`);
  const available = assets.map((a) => a.name).join(', ') || 'none';
  if (!zip || !checksum) {
    const missing = [!zip ? zipName : null, !checksum ? `${zipName}.sha256` : null].filter(Boolean).join(' and ');
    throw new ReleaseError(`the GitHub Release for v${version} does not carry ${missing} (assets: ${available}). Only a package published by the Release workflow can be retried.`, { stage: 'assets', retryable: false });
  }
  return { zip, checksum, provenance: byName('provenance.json'), zipName };
}

/**
 * Downloads one asset's bytes.
 * @param {ReleaseAsset} asset
 * @param {{ token: string }} auth
 * @param {ReleaseDeps} deps
 * @returns {Promise<Buffer>}
 */
export async function downloadAsset(asset, { token }, deps) {
  const response = await request('GET', asset.url, { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' }, deps.fetch, 'download');
  if (!response.ok) throw new ReleaseError(describeHttpFailure(response.status, `downloading ${asset.name}`), { status: response.status, stage: 'download' });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (typeof asset.size === 'number' && asset.size !== bytes.length) {
    throw new ReleaseError(`downloaded ${asset.name} is ${bytes.length} bytes but the release lists ${asset.size}; the download is incomplete or the asset changed`, { stage: 'download', retryable: true });
  }
  return bytes;
}

/**
 * Verifies that the downloaded assets form a consistent, untampered release package.
 * @param {{ version: string, zipName: string, zip: Buffer, checksumText: string, provenance: unknown | null, releaseCommit?: string | null }} input
 * @returns {{ problems: string[], sha256: string, entries: string[] }}
 */
export function verifyReleaseAssets({ version, zipName, zip, checksumText, provenance, releaseCommit = null }) {
  /** @type {string[]} */
  const problems = [];
  const sha256 = sha256Of(zip);

  const checksum = parseChecksumFile(checksumText);
  if (!checksum) problems.push(`${zipName}.sha256 is not a sha256sum checksum file`);
  else {
    if (checksum.name !== zipName) problems.push(`${zipName}.sha256 names ${checksum.name}, expected ${zipName}`);
    if (checksum.sha256 !== sha256) problems.push(`SHA-256 mismatch: ${zipName} is ${sha256}, the release checksum says ${checksum.sha256}`);
  }

  const verification = verifyPackage(zip, { version });
  problems.push(...verification.problems);

  if (provenance !== null) {
    problems.push(...validateProvenance(provenance, { version, zipName, sha256, bytes: zip.length, entries: verification.entries.length }));
    if (isRecord(provenance) && typeof releaseCommit === 'string' && /^[0-9a-f]{40}$/i.test(releaseCommit) && typeof provenance.commit === 'string' && provenance.commit.toLowerCase() !== releaseCommit.toLowerCase()) {
      problems.push(`provenance.json records commit ${provenance.commit} but the release points at ${releaseCommit}`);
    }
  }

  return { problems, sha256, entries: verification.entries };
}

/**
 * Fetches and verifies the release package for `version`. Returns the bytes only when every
 * check passed, so callers can hand them straight to the store.
 * @param {{ repository: string, version: string, token: string }} input
 * @param {ReleaseDeps} deps
 * @returns {Promise<{ tag: string, zipName: string, zip: Buffer, sha256: string, checksumText: string, provenance: unknown | null, entries: string[], releaseUrl: string | null }>}
 */
export async function fetchVerifiedReleasePackage({ repository, version, token }, deps) {
  const { log = () => {} } = deps;
  if (!VERSION_PATTERN.test(version)) throw new ReleaseError(`"${version}" is not a release version (MAJOR.MINOR.PATCH)`, { stage: 'input', retryable: false });
  const tag = `v${version}`;

  const release = await fetchRelease({ repository, tag, token }, deps);
  const releaseUrl = typeof release.html_url === 'string' ? release.html_url : null;
  log(`Found GitHub Release ${tag}${releaseUrl ? ` (${releaseUrl})` : ''}.`);

  const assets = selectReleaseAssets(release, version);
  const [zip, checksumBytes, provenanceBytes] = await Promise.all([
    downloadAsset(assets.zip, { token }, deps),
    downloadAsset(assets.checksum, { token }, deps),
    assets.provenance ? downloadAsset(assets.provenance, { token }, deps) : Promise.resolve(null),
  ]);
  log(`Downloaded ${assets.zipName} (${zip.length} bytes), its checksum${assets.provenance ? ' and provenance.json' : ''}.`);

  /** @type {unknown | null} */
  let provenance = null;
  if (provenanceBytes) {
    try {
      provenance = JSON.parse(provenanceBytes.toString('utf8'));
    } catch {
      throw new ReleaseError('provenance.json in the release is not valid JSON', { stage: 'verify', retryable: false });
    }
  }

  const releaseCommit = typeof release.target_commitish === 'string' ? release.target_commitish : null;
  const { problems, sha256, entries } = verifyReleaseAssets({ version, zipName: assets.zipName, zip, checksumText: checksumBytes.toString('utf8'), provenance, releaseCommit });
  if (problems.length > 0) {
    throw new ReleaseError(`the release assets for ${tag} failed verification:\n  - ${problems.join('\n  - ')}`, { stage: 'verify', retryable: false });
  }
  log(`Verified ${assets.zipName}: SHA-256 ${sha256}, ${entries.length} files, manifest version ${version}${provenance ? ', provenance consistent' : ', no provenance.json attached'}.`);
  return { tag, zipName: assets.zipName, zip, sha256, checksumText: checksumBytes.toString('utf8'), provenance, entries, releaseUrl };
}
